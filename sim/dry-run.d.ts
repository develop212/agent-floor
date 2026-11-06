import type { StudioEvent } from '../src/studio/state';
export function createDryRunEvents(now?: number): StudioEvent[];
export function runDryRun(emit: (event: StudioEvent) => void, options?: { delayMs?: number; now?: number }): Promise<void>;
