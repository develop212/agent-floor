export type StudioEventType = 'claim_confirmed' | 'claim_rejected' | 'blocked' | 'report_ready' | 'review_result' | 'bridge_status';
export interface StudioEvent { type: StudioEventType; agent?: string; task_id?: string; task_title?: string; source?: string; reason?: string; report_url?: string; report_local?: string; summary?: string; result?: string; note?: string; mode?: string; connected?: boolean; last_update_ts?: number; ts?: number }
export interface StudioAction { action: 'claim_request' | 'review'; agent?: string; task_id?: string; result?: string; note?: string; ts: number }
export interface StudioReport { taskId: string; status: 'ready' | 'rejected'; summary: string; reportUrl: string | null; reportLocal: string | null; note: string }
export interface StudioState {
  bridge: { received: boolean; mode: string; connected: boolean | null; lastUpdateTs: number | null; note: string };
  engineer: { taskId: string | null; taskTitle: string; blocked: { taskId: string; reason: string } | null; claimPending: boolean; lastRejection: string | null };
  reports: Record<string, StudioReport>; reportOrder: string[]; reviewPending: Record<string, { result: string; note: string }>; notice: string; actions: StudioAction[];
}
export function createStudioState(): StudioState;
export function applyStudioEvent(state: StudioState, ev: StudioEvent): StudioState;
export function beginStudioAction(state: StudioState, payload: Omit<StudioAction, 'ts'> & { ts?: number }): StudioAction;
export function latestReport(state: StudioState): StudioReport | null;
export function bridgeView(state: StudioState, now?: number): { text: string; stale: boolean; note: string };
export class StudioStore {
  state: StudioState;
  constructor();
  subscribe(fn: () => void): () => boolean;
  onEvent(fn: (ev: StudioEvent) => void): () => boolean;
  apply(ev: StudioEvent): void;
  emit(): void;
  beginAction(payload: Omit<StudioAction, 'ts'> & { ts?: number }): StudioAction;
}
