import { EventError } from '@cassie/harness';

export interface UnderstandingConfig { baseUrl: string; apiKey: string; model: string }
export interface SampledImage { frame: number; data: string }
export function checkUnderstandingConfig(value: unknown): UnderstandingConfig {
  const c = value as UnderstandingConfig | undefined;
  if (!c || typeof c.baseUrl !== 'string' || typeof c.model !== 'string' || !c.model.trim() || c.model.length > 200 || typeof c.apiKey !== 'string' || !c.apiKey.trim()) throw new EventError('MODEL_CONFIG', '请配置支持图像输入的模型地址、型号和 API Key');
  let url: URL;
  try { url = new URL(c.baseUrl); } catch { throw new EventError('MODEL_CONFIG', '模型地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new EventError('MODEL_CONFIG', '模型地址必须是无凭据、无查询参数的 HTTP(S) 地址');
  return { baseUrl: c.baseUrl.replace(/\/$/, ''), apiKey: c.apiKey, model: c.model.trim() };
}
/** Uses the project's existing BYOK OpenAI-compatible / Anthropic wire contracts. Keys never enter artifacts. */
export async function understandingCall(config: UnderstandingConfig, system: string, prompt: string, images: SampledImage[], signal?: AbortSignal): Promise<string> {
  const cfg = checkUnderstandingConfig(config), anthropic = /anthropic/i.test(cfg.baseUrl);
  const content = anthropic
    ? [{ type: 'text', text: prompt }, ...images.flatMap(image => [{ type: 'text', text: `SOURCE_FRAME ${image.frame}` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } }])]
    : [{ type: 'text', text: prompt }, ...images.flatMap(image => [{ type: 'text', text: `SOURCE_FRAME ${image.frame}` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.data}` } }])];
  const endpoint = anthropic ? `${cfg.baseUrl.replace(/\/v1$/, '')}/v1/messages` : `${cfg.baseUrl}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(anthropic ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${cfg.apiKey}` }) },
    body: JSON.stringify(anthropic
      ? { model: cfg.model, max_tokens: 6000, system, messages: [{ role: 'user', content }] }
      : { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  // Upstream bodies can contain request credentials; don't relay or persist them.
  if (!response.ok) throw new EventError('MODEL_FAILED', `视觉模型返回 ${response.status}；请检查型号是否支持多图输入及额度`);
  const body = await response.json() as { choices?: { message?: { content?: string } }[]; content?: { type: string; text?: string }[] };
  const result = anthropic ? body.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('') : body.choices?.[0]?.message?.content;
  if (typeof result !== 'string' || !result.trim() || result.length > 100_000) throw new EventError('MODEL_FAILED', '视觉模型返回为空或超限');
  return result;
}
