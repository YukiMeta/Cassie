import type { AnalysisSource, FrameRange, GroundedCandidate, ObservedEntity, ObservedEvent, SemanticGrounding, VideoAnalysis } from '@cassie/spec';
import { EventError } from '@cassie/harness';

const fail = (message: string): never => { throw new EventError('INVALID_ANALYSIS', message); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('Missing or oversized text');
  return (value as string).trim();
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Missing or oversized array');
  return value as unknown[];
}
function id(value: unknown): string {
  const s = text(value, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) fail('Invalid observation id');
  return s;
}
function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length) fail('Duplicate ids');
  return values;
}
function range(value: unknown, source: AnalysisSource): FrameRange {
  const r = object(value), a = r.startFrame, b = r.endFrame;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || Number(a) < 0 || Number(b) > source.frames || Number(a) >= Number(b)) fail('Frame range is outside the source');
  return { startFrame: Number(a), endFrame: Number(b) };
}
function evidence(value: unknown, allowed: number[]): number[] {
  const frames = list(value, 64);
  if (!frames.length || frames.some(f => !Number.isSafeInteger(f) || !allowed.includes(Number(f)))) fail('Evidence must reference frames actually supplied to the model');
  return [...new Set(frames.map(Number))].sort((a,b) => a-b);
}
function checkOverlap(frames: number[], ranges: FrameRange[]) {
  if (!frames.some(f => ranges.some(r => f >= r.startFrame && f < r.endFrame))) fail('Evidence does not intersect the observed range');
}
export function parseModelJson(value: string): unknown {
  const raw = value.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return fail('Model did not return a JSON object'); }
}
/** Reject hallucinated references, out-of-bounds times and invented evidence, not just malformed JSON. */
export function parseObservation(value: unknown, source: AnalysisSource, sampledFrames: number[]): Pick<VideoAnalysis, 'summary'|'entities'|'events'|'uncertainties'> {
  const v = object(value);
  const entities: ObservedEntity[] = list(v.entities, 20).map(item => {
    const e = object(item), ranges = list(e.visibleRanges, 30).map(r => range(r, source));
    if (!ranges.length) fail('Entity has no visible range');
    const frames = evidence(e.evidenceFrames, sampledFrames); checkOverlap(frames, ranges);
    return { id: id(e.id), name: text(e.name, 120), description: text(e.description), visibleRanges: ranges, evidenceFrames: frames };
  });
  const entityIds = unique(entities.map(e => e.id));
  const events: ObservedEvent[] = list(v.events, 40).map(item => {
    const e = object(item), refs = unique(list(e.entityIds, 10).map(id));
    if (refs.some(ref => !entityIds.includes(ref))) fail('Event references an unknown entity');
    const r = range(e.range, source), frames = evidence(e.evidenceFrames, sampledFrames); checkOverlap(frames, [r]);
    if (typeof e.uncertainty !== 'string' || e.uncertainty.length > 2000) fail('Event uncertainty must be a string');
    return { id: id(e.id), entityIds: refs, description: text(e.description), range: r, evidenceFrames: frames, uncertainty: String(e.uncertainty) };
  });
  unique(events.map(e => e.id));
  return { summary: text(v.summary, 4000), entities, events: events.sort((a,b) => a.range.startFrame-b.range.startFrame), uncertainties: list(v.uncertainties, 30).map(u => text(u)) };
}
export function parseGrounding(value: unknown, analysis: VideoAnalysis, sampledFrames: number[]): Pick<SemanticGrounding,'status'|'candidates'|'explanation'> {
  const v = object(value);
  if (!['resolved','ambiguous','not_found'].includes(String(v.status))) fail('Invalid grounding status');
  const candidates: GroundedCandidate[] = list(v.candidates, 4).map(item => {
    const c = object(item), refs = unique(list(c.entityIds, 10).map(id));
    if (refs.some(ref => !analysis.entities.some(e => e.id === ref))) fail('Unknown target entity');
    const eventId = c.eventId === null ? null : id(c.eventId);
    const event = analysis.events.find(e => e.id === eventId);
    if (eventId !== null && !event) fail('Unknown target event');
    if (!eventId && !refs.length) fail('A target needs an event or entity');
    if (event && refs.some(ref => !event.entityIds.includes(ref))) fail('Target entity is not part of the event');
    const r = range(c.range, analysis.source), frames = evidence(c.evidenceFrames, sampledFrames); checkOverlap(frames, [r]);
    const referenceRanges = event ? [event.range] : analysis.entities.filter(e => refs.includes(e.id)).flatMap(e => e.visibleRanges);
    if (!referenceRanges.some(ref => r.startFrame < ref.endFrame && ref.startFrame < r.endFrame)) fail('Target does not overlap its observation');
    return { eventId, entityIds: refs, range: r, evidenceFrames: frames, reason: text(c.reason) };
  });
  if ((v.status === 'resolved' && candidates.length !== 1) || (v.status === 'ambiguous' && candidates.length < 2) || (v.status === 'not_found' && candidates.length !== 0)) fail('Grounding status contradicts candidate count');
  return { status: v.status as SemanticGrounding['status'], candidates, explanation: text(v.explanation) };
}
