import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeExecutable } from './agent-tools';
import { sam3Service } from './concept';
import { jevKey } from './locate';
import { runProcess } from './media';

/**
 * What this machine can do right now, and the one command that fixes each missing piece.
 * `needed` capabilities block core editing; the rest unlock one feature each.
 */
export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  needed: boolean;
  detail: string;
  fix?: string;
  /** What stops working while this is missing. */
  unlocks: string;
}

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const OWL = join(homedir(), '.cache', 'huggingface', 'hub', 'models--google--owlv2-base-patch16-ensemble');

async function version(command: string, args = ['-version']) {
  try { return (await runProcess(command, args, { timeoutMs: 5_000 })).split('\n')[0]!.trim(); } catch { return null; }
}

export async function doctor(): Promise<DoctorCheck[]> {
  const [ffmpeg, ffprobe, swift, chrome, sam3] = await Promise.all([
    version('ffmpeg'), version('ffprobe'), process.platform === 'darwin' ? version('swiftc', ['--version']) : Promise.resolve(null),
    chromeExecutable().catch(() => null), sam3Service(),
  ]);
  const venv = join(repo, '.cassie-cache/detect-venv/bin/python');
  const owl = existsSync(venv) && existsSync(OWL);
  const provider = process.env.CASSIE_SUBJECT_PROVIDER;
  return [
    { id: 'ffmpeg', label: 'ffmpeg / ffprobe', ok: !!ffmpeg && !!ffprobe, needed: true, detail: ffmpeg ?? '未找到', fix: 'brew install ffmpeg', unlocks: '导入素材、海报帧、导出成片' },
    { id: 'chrome', label: '渲染用 Chrome', ok: !!chrome, needed: true, detail: chrome ? 'HyperFrames 预览与导出可用' : '未找到', fix: 'npx puppeteer browsers install chrome', unlocks: '截帧自检、导出成片' },
    { id: 'tracker', label: '本地逐帧跟踪（macOS）', ok: !!swift, needed: false, detail: swift ?? (process.platform === 'darwin' ? '缺少 Xcode 命令行工具' : '仅 macOS'), fix: process.platform === 'darwin' ? 'xcode-select --install' : undefined, unlocks: '没有 SAM 3 时的物体跟踪、人物抠像' },
    {
      id: 'locator', label: '定位（SAM 之前）', ok: !!jevKey() || owl, needed: false,
      detail: jevKey() ? 'Jev Box：问「这个东西在哪」，失败后按经验放大或改问法' : owl ? '本地 OWLv2 定位（未配置 Jev）' : '没有 Jev key，也没有本地检测器',
      fix: jevKey() || owl ? undefined : '设置 CASSIE_JEV_KEY，或 npm run setup:detector', unlocks: '找到种子框，再交给跟踪 / SAM 3',
    },
    {
      id: 'detector', label: '跟踪 / 分割', ok: !!sam3 || !!swift, needed: false,
      detail: sam3 ? `SAM 3 服务 ${sam3}` : swift ? '本地逐帧跟踪（macOS）' : '没有 SAM 3，也没有本地跟踪器',
      fix: sam3 || swift ? undefined : '按 servers/sam3/README.md 启动 SAM 3，或 xcode-select --install', unlocks: '把定位到的框跟完整段镜头',
    },
    { id: 'provider', label: '换主体服务', ok: !!provider, needed: false, detail: provider ? '已配置（付费，每次先报价确认）' : '未配置：换主体只会生成请求包', fix: provider ? undefined : '设置 CASSIE_SUBJECT_PROVIDER 指向服务配置 JSON', unlocks: '按参考图替换变体里的主体' },
  ];
}
