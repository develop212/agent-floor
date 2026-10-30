import { createScript } from '../../shared/demo-script.js';
import type { Effect, FloorEvent, WorldState } from '../../shared/protocol';
import { store } from './store';
import { DEMO_ONLY } from '../config';

const params = new URLSearchParams(location.search);

/** Where the floor server lives. Same origin by default; `?server=` overrides. */
export function serverBase() {
  const explicit = params.get('server');
  if (explicit) return explicit.replace(/\/$/, '');
  return '';
}

let demoTimer: number | undefined;
let sweepTimer: number | undefined;
let demoRunning = false;

export function startDemo() {
  if (demoRunning) return;
  demoRunning = true;
  store.replace({ teams: {}, agents: {}, seq: 0, updatedAt: Date.now() });
  store.setMode('demo');
  const script = createScript();
  const step = () => {
    const { wait, events } = script.next();
    for (const ev of events) store.applyLocal({ ...ev, ts: Date.now() });
    demoTimer = window.setTimeout(step, wait);
  };
  step();
  sweepTimer = window.setInterval(() => store.sweepLocal(), 2000);
}

export function stopDemo() {
  if (!demoRunning) return;
  demoRunning = false;
  window.clearTimeout(demoTimer);
  window.clearInterval(sweepTimer);
}

export function isDemoRunning() {
  return demoRunning;
}

export function connect() {
  if (params.has('demo') || (DEMO_ONLY && !params.has('server'))) {
    startDemo();
    return;
  }
  const base = serverBase();
  let opened = false;
  // Without a reachable server (hosted demo, floor not started) show the demo
  // after a moment, but keep retrying so a live floor takes over when it appears.
  const fallback = window.setTimeout(() => {
    if (!opened) startDemo();
  }, 2200);

  const open = () => {
    const es = new EventSource(`${base}/stream`);
    es.addEventListener('snapshot', (msg) => {
      opened = true;
      window.clearTimeout(fallback);
      stopDemo();
      const { state } = JSON.parse((msg as MessageEvent).data) as { state: WorldState };
      store.replace(state);
      store.setMode('live');
    });
    es.addEventListener('event', (msg) => {
      if (demoRunning) return;
      const { event, effects } = JSON.parse((msg as MessageEvent).data) as { event: FloorEvent; effects: Effect[] };
      store.applyRemote(event, effects);
    });
    es.addEventListener('removed', (msg) => {
      if (demoRunning) return;
      store.remove((JSON.parse((msg as MessageEvent).data) as { agents: string[] }).agents);
    });
    es.onerror = () => {
      if (!demoRunning && opened) store.setMode('connecting');
      // EventSource retries on its own while the server answers with errors;
      // if it gives up (CLOSED) we retry after a pause.
      if (es.readyState === EventSource.CLOSED) window.setTimeout(open, 3000);
    };
  };
  open();
}
