import { useState } from 'react';
import { setPlayhead, togglePlay, useAppState } from '../store';
import { VideoUnderstanding } from './VideoUnderstanding';
import { Stage } from './Stage';

/** A result viewer for the agent-owned project; editor layout preferences do not apply. */
export function Viewer() {
  const state = useAppState();
  const [view, setView] = useState<'source' | 'film'>('source');
  const project = state.adapter.getProject();
  const history = state.runtime?.workspace.transactions.slice(-8).reverse() ?? [];
  return <main className="viewer">
    <nav className="viewer-nav" aria-label="预览内容">
      <button aria-pressed={view === 'source'} onClick={() => { if (state.playing) togglePlay(); setView('source'); }}>源片与证据</button>
      <button disabled={!state.runtime} aria-pressed={view === 'film'} onClick={() => setView('film')}>成片预览</button>
      <span className="viewer-status">{state.busy || (state.runtime ? '本地工程已连接' : '等待连接本地工程')}</span>
    </nav>
    {view === 'source' ? <VideoUnderstanding onFilmSeek={() => { setView('film'); window.scrollTo(0, 0); }} /> : <section className="film-view">
      <Stage />
      <div className="viewer-transport">
        <button aria-label={state.playing ? '暂停成片' : '播放成片'} onClick={togglePlay}>{state.playing ? '暂停' : '播放'}</button>
        <input aria-label="成片播放位置" type="range" min={0} max={project.settings.durationUs} step={1000} value={state.playheadUs} onChange={e => setPlayhead(Number(e.target.value))}/>
        <output>{(state.playheadUs / 1e6).toFixed(1)} / {(project.settings.durationUs / 1e6).toFixed(1)}s</output>
      </div>
    </section>}
    {state.runtime && <details className="viewer-history"><summary>修改记录{history.length ? ` · ${history.length}` : ''}</summary>
      {history.length ? <ul>{history.map(t => <li key={t.id}><span>{t.edit.kind === "apply-grounded-recolor" ? "瓶身改色" : t.edit.kind}</span><small>{t.status === 'committed' ? '已应用' : '已撤销'}</small></li>)}</ul> : <p>暂无修改</p>}
    </details>}
  </main>;
}
