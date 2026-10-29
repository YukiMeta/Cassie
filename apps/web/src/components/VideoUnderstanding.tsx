import { useEffect, useRef, useState } from 'react';
import { providerWorkbench } from '../lib/workspace-mode';
import type { FrameRange, SemanticGrounding, VideoAnalysis } from '@cassie/spec';
import { reloadRuntime, setPlayhead, setSettingsOpen, useAppState } from '../store';
import { analyzeSource, evidenceFrameUrl, fetchUnderstanding, groundSource, importAnalysisVideo, mediaUrl } from '../lib/runtime';

type EvidenceSelection = { label: string; range: FrameRange; frames: number[] };
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Facts and evidence refer to source media; viewing them never edits the timeline or undo stack. */
export function VideoUnderstanding() {
  const state = useAppState();
  const document = state.runtime?.document;
  const assets = Object.values(document?.editor.assets ?? {}).filter(a => a.kind === 'video' && document?.media[a.id]);
  const [chosenAsset, setChosenAsset] = useState('');
  const assetId = assets.some(a => a.id === chosenAsset) ? chosenAsset : assets.at(-1)?.id ?? '';
  const hash = document?.media[assetId]?.sha256;
  const [cachedAnalysis, setAnalysis] = useState<VideoAnalysis | null>(null);
  const analysis = cachedAnalysis && cachedAnalysis.source.sha256 === hash && cachedAnalysis.source.assetId === assetId ? cachedAnalysis : null;
  const [cachedGrounding, setGrounding] = useState<SemanticGrounding | null>(null);
  const grounding = cachedGrounding?.analysisId === analysis?.id && cachedGrounding?.sourceSha256 === hash ? cachedGrounding : null;
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const fps = analysis ? analysis.source.frameRate.num / analysis.source.frameRate.den : 1;
  const ready = state.modelConfig.llm.enabled && Boolean(state.modelConfig.llm.apiKey);

  useEffect(() => {
    let disposed=false;
    generation.current++;
    setAnalysis(null); setGrounding(null); setSelection(null); setError(''); setMessage(''); setPending(false);
    if (!assetId) return;
    const refresh=async()=>{
      try {
        const result=await fetchUnderstanding(assetId);
        if(!disposed){
          if(!providerWorkbench)setError('');
          setAnalysis(previous=>previous?.id===result.analysis?.id && previous?.source.assetId===assetId ? previous : result.analysis);
          setGrounding(previous=>previous?.id===result.grounding?.id ? previous : result.grounding);
        }
      }catch(e){if(!disposed)setError(errorMessage(e));}
    };
    void refresh();
    const timer=setInterval(()=>void refresh(),3000);
    return()=>{disposed=true;generation.current++;clearInterval(timer);};
  }, [assetId, hash]);

  useEffect(() => {
    const player = video.current;
    if (!player || !selection || !analysis) return;
    const seek = () => { player.pause(); player.currentTime = selection.range.startFrame / fps; };
    if (player.readyState >= 1) seek();
    else player.addEventListener('loadedmetadata', seek, { once: true });
    return () => player.removeEventListener('loadedmetadata', seek);
  }, [selection, analysis, fps]);

  useEffect(() => {
    const first=grounding?.status==='resolved'?grounding.candidates[0]:null;
    setSelection(first?{label:first.reason,range:first.range,frames:first.evidenceFrames}:null);
  }, [grounding?.id, analysis?.id]);

  const run = async (kind: 'analyze'|'ground') => {
    if (!ready || !assetId || pending) return;
    const current = ++generation.current;
    setPending(true); setError(''); setGrounding(null); setSelection(null);
    const progress = (m: string) => { if (generation.current === current) setMessage(m); };
    try {
      if (kind === 'analyze') {
        const result = await analyzeSource(assetId, state.modelConfig.llm, progress);
        if (generation.current === current) setAnalysis(result);
      } else if (analysis) {
        const result = await groundSource(assetId, analysis.id, query, state.modelConfig.llm, progress);
        if (generation.current === current) {
          setGrounding(result);
          const first = result.status === 'resolved' ? result.candidates[0] : null;
          if (first) setSelection({ label: first.reason, range: first.range, frames: first.evidenceFrames });
        }
      }
    } catch (e) { if (generation.current === current) setError(errorMessage(e)); }
    finally { if (generation.current === current) setPending(false); }
  };
  const time = (r: FrameRange) => `${(r.startFrame/fps).toFixed(2)}–${(r.endFrame/fps).toFixed(2)}s`;
  const timelineMatches = selection && document ? document.editor.tracks.flatMap(t => t.clips).filter(c => c.assetId === assetId && selection.range.startFrame / fps * 1e6 >= c.sourceInUs && selection.range.endFrame / fps * 1e6 <= c.sourceInUs + c.endUs-c.startUs) : [];

  if (!document) return <div className="understanding"><p>Caption 与证据预览需要连接本机运行时。</p><p>用 <code>npm start project.cassie.json</code> 打开工程后，这里只查看 Agent 的观察和证据。</p></div>;
  return <div className="understanding">
    <p className="understanding-intro">Agent 的观察、定位与证据会自动出现在这里。查看结果不会修改工程。</p>
    {providerWorkbench && <><label className="secondary-btn understanding-upload">添加 ≤15s 理解素材
      <input type="file" accept="video/mp4,.mp4" aria-label="添加理解视频" disabled={pending || Boolean(state.busy)} onChange={e => {
        const file=e.target.files?.[0]; e.target.value=''; if(!file)return;
        setPending(true); setError(''); setMessage('导入短视频…');
        void importAnalysisVideo(file).then(async result => { await reloadRuntime(); setChosenAsset(result.assetId); }).catch(e => setError(errorMessage(e))).finally(()=>setPending(false));
      }}/>
    </label>
    <p className="understanding-note">添加为可撤销的源素材，不加入成片时间线；本页预览源片，导出仍使用现有时间线。支持 CFR MP4，VFR 请先规范化。</p></>}
    <label className="understanding-field">源视频（≤15s）
      <select aria-label="选择 Caption 源视频" value={assetId} onChange={e => setChosenAsset(e.target.value)} disabled={pending}>
        {!assets.length && <option value="">工程中没有视频素材</option>}
        {assets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </label>
    {assetId && !selection && <video className="source-preview" key={assetId} src={mediaUrl(assetId)} controls playsInline preload="metadata" aria-label="理解源视频"/>}
    {!assets.length && <p>等待 Agent 打开本地短片。这里不需要上传文件。</p>}
    {providerWorkbench && !ready && <p>需要支持多图输入的视觉语言模型。<button className="tool-btn" onClick={() => setSettingsOpen(true)}>配置模型</button></p>}
    {providerWorkbench && <><button className="primary-btn" disabled={!assetId || !ready || pending} onClick={() => void run('analyze')}>{pending ? '处理中…' : analysis ? '重新分析短片' : '分析短片'}</button>
    <p className="understanding-note">点击分析会将至多 32 张采样图发送给你配置的模型；语义定位按需复看至多 64 张图。稀疏采样可能遗漏短暂动作。</p></>}
    {message && <p role="status">{message}</p>}
    {error && <p className="understanding-error" role="alert">{error}</p>}
    {!analysis && assets.length>0 && <p>素材已就绪，等待 Agent 提交观察。证据不足或存在歧义时会明确标记。</p>}
    {analysis && <>
      <div className="section-label"><span>视频描述</span><span>模型观察 · 待核对</span></div>
      <p>{analysis.summary}</p>
      <details><summary>分析依据与不确定性</summary><p>{analysis.model} · {analysis.sampling.frameNumbers.length} 张采样图</p><p>{analysis.promptVersion}</p>{analysis.uncertainties.length ? <ul>{analysis.uncertainties.map((u,i) => <li key={i}>{u}</li>)}</ul> : <p>模型未列出额外不确定性；仍需核对证据。</p>}</details>
      <div className="section-label"><span>对象</span><span>{analysis.entities.length}</span></div>
      {analysis.entities.map(e => <button key={e.id} className="observation-card" onClick={() => setSelection({label:e.name,range:e.visibleRanges[0]!,frames:e.evidenceFrames})}><strong>{e.name}</strong><span>{e.description}</span><small>{e.visibleRanges.map(time).join(' / ')}</small></button>)}
      <div className="section-label"><span>动作与事件</span><span>{analysis.events.length}</span></div>
      {!analysis.events.length && <p>没有得到有证据的动作事件；请勿据此推断视频中没有动作。</p>}
      {analysis.events.map(e => <button key={e.id} className="observation-card" onClick={() => setSelection({label:e.description,range:e.range,frames:e.evidenceFrames})}><strong>{e.description}</strong><small>{time(e.range)} · 查看证据</small>{e.uncertainty && <span>{e.uncertainty}</span>}</button>)}
      {providerWorkbench && <form onSubmit={e => { e.preventDefault(); void run('ground'); }}>
        <label className="understanding-field">用一句话定位
          <textarea aria-label="语义定位指令" value={query} disabled={pending} maxLength={2000} onChange={e => setQuery(e.target.value)} placeholder="例如：她第二次拿起杯子的那一段" rows={3}/>
        </label>
        <button className="secondary-btn" disabled={!query.trim() || !ready || pending}>定位并复看证据</button>
      </form>}
      {grounding && <div className="grounding-result" role="status"><strong>{grounding.status === 'resolved' ? '已定位 · 请核对' : grounding.status === 'ambiguous' ? '存在多个候选，尚未消歧' : '没有足够证据定位'}</strong><p>定位请求：{grounding.query}</p><p>{grounding.explanation}</p>{grounding.candidates.map((c,i) => <button className="observation-card" key={i} onClick={() => setSelection({label:c.reason,range:c.range,frames:c.evidenceFrames})}><strong>候选 {i+1} · {time(c.range)}</strong><span>{c.reason}</span></button>)}</div>}
      {selection && <div className="evidence-preview">
        <div className="section-label"><span>源视频证据</span><span>{time(selection.range)}</span></div>
        <p>{selection.label}</p>
        <video key={assetId} ref={video} src={mediaUrl(assetId)} controls playsInline preload="metadata" aria-label="源视频证据播放" onTimeUpdate={() => { const p=video.current; if(p && !p.paused && p.currentTime >= selection.range.endFrame/fps) { p.pause(); p.currentTime=(selection.range.endFrame-1)/fps; } }}/>
        <button className="tool-btn" onClick={() => { if(video.current) { video.current.currentTime=selection.range.startFrame/fps; void video.current.play().catch(()=>undefined); } }}>播放选中片段</button>
        {timelineMatches.length === 1 && <button className="tool-btn" onClick={() => { const c=timelineMatches[0]!; setPlayhead(c.startUs+selection.range.startFrame/fps*1e6-c.sourceInUs); }}>定位到时间线</button>}
        <p className="understanding-note">时间和帧号均属于源素材。{timelineMatches.length !== 1 ? '时间线没有唯一对应片段，仅预览源视频。' : ''}</p>
        <div className="evidence-grid">{selection.frames.slice(0,6).map(frame => <button key={frame} onClick={() => { if(video.current) { video.current.pause(); video.current.currentTime=frame/fps; } }}><img loading="lazy" src={evidenceFrameUrl(assetId,frame)} alt={`源帧 ${frame}，${(frame/fps).toFixed(2)} 秒`}/><small>帧 {frame} · {(frame/fps).toFixed(2)}s</small></button>)}</div>
      </div>}
    </>}
  </div>;
}
