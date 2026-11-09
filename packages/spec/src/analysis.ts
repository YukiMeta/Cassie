/** Source observations are separate from authored timeline events and never mutate a workspace. */
export interface FrameRange { startFrame: number; endFrame: number }
export interface AnalysisSource {
  assetId: string;
  sha256: string;
  frames: number;
  frameRate: { num: number; den: number };
  width: number;
  height: number;
}
export interface ObservedEntity {
  id: string;
  name: string;
  description: string;
  visibleRanges: FrameRange[];
  evidenceFrames: number[];
}
export interface ObservedEvent {
  id: string;
  entityIds: string[];
  description: string;
  range: FrameRange;
  evidenceFrames: number[];
  uncertainty: string;
}
export interface VideoAnalysis {
  schema: 'cassie/analysis@1';
  id: string;
  source: AnalysisSource;
  createdAt: string;
  model: string;
  promptVersion: string;
  sampling: { frameNumbers: number[]; strategy: string };
  summary: string;
  entities: ObservedEntity[];
  events: ObservedEvent[];
  uncertainties: string[];
  /** Model observations remain proposals until a human checks their evidence. */
  status: 'proposed';
}
export interface GroundedCandidate {
  eventId: string | null;
  entityIds: string[];
  range: FrameRange;
  evidenceFrames: number[];
  reason: string;
}
export interface SemanticGrounding {
  schema: 'cassie/grounding@1';
  id: string;
  analysisId: string;
  sourceSha256: string;
  query: string;
  status: 'resolved' | 'ambiguous' | 'not_found';
  candidates: GroundedCandidate[];
  explanation: string;
  sampling: { frameNumbers: number[]; strategy: string };
}
