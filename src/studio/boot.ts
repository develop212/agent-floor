import './studio.css';
import { createState } from '../../shared/protocol.js';
import { runDryRun } from '../../sim/dry-run.js';
import { store } from '../core/store';
import { World } from '../world/World';
import { StudioHud } from './StudioHud';
import { latestReport, StudioStore, type StudioEvent } from './state';
import { postStudioAction, type StudioActionPayload } from './transport';

export async function bootStudio(app: HTMLElement, stage: HTMLElement) {
  document.title = 'MSOS 工作室 · 模拟模式';
  document.documentElement.dataset.theme = 'light';
  app.classList.add('studio-mode');
  stage.classList.add('studio-stage');

  const studio = new StudioStore();
  let hud: StudioHud;
  const world = new World(stage, {
    onPick(agentId) { if (agentId) hud.openAgent(agentId); },
    onHover() { /* Studio tags provide their own hover state. */ },
    onMessage() { /* No real messages are sent in dry-run. */ },
  });

  const sendAction = async (payload: Omit<StudioActionPayload, 'ts'>) => {
    const action = studio.beginAction({ ...payload, ts: Date.now() });
    try {
      await postStudioAction(action);
    } catch {
      studio.state.notice = '模拟｜本地动作处理器未接受请求，请重试';
      studio.state.engineer.claimPending = false;
      if (action.task_id) delete studio.state.reviewPending[action.task_id];
      studio.emit();
    }
  };

  hud = new StudioHud(app, studio, {
    claim: () => { void sendAction({ action: 'claim_request', agent: 'engineer' }); },
    review: (taskId, result, note) => { void sendAction({ action: 'review', task_id: taskId, result, note }); },
  });

  store.replace(createState());
  store.subscribe(() => world.sync(store.state));
  store.applyLocal({ type: 'join', agent: 'coo', name: 'COO', role: 'Lead', source: 'dry-run', team: 'MSOS 工作室', activity: '模拟｜确认任务与验收' });
  store.applyLocal({ type: 'join', agent: 'engineer', name: 'Engineer', role: 'Engineer', source: 'dry-run', team: 'MSOS 工作室', activity: '模拟｜等待领取任务' });
  store.setMode('demo');
  world.setTheme('light');
  // Frame only the two-person MSOS room, not the surrounding demo amenities.
  world.focusStudio();

  studio.onEvent((ev) => {
    if (ev.type === 'claim_confirmed' && ev.agent === 'engineer') world.walkEngineerToCoo();
  });
  studio.subscribe(() => {
    const current = store.state.agents.engineer;
    const engineer = studio.state.engineer;
    const status = engineer.blocked ? 'waiting' : engineer.taskId ? 'working' : 'idle';
    const activity = engineer.blocked ? `模拟｜举手：${engineer.blocked.reason}` : engineer.taskTitle;
    if (current && (current.status !== status || current.activity !== activity)) {
      store.applyLocal({ type: 'status', agent: 'engineer', status, activity });
    }
    const report = latestReport(studio.state);
    world.setStudioReport(report ? report.status : null);
  });

  world.onFrame = () => hud.frame(world.anchors(), world.deskAnchor('engineer'));
  setInterval(() => hud.tick(), 1000);

  const dispatch = (event: StudioEvent) => studio.apply(event);
  const params = new URLSearchParams(location.search);
  const now = Date.now();
  dispatch({ type: 'bridge_status', mode: 'dry-run', connected: true, last_update_ts: now, note: '模拟｜本地 dry-run 已就绪' });

  const capture = params.get('capture');
  if (capture === 'waiting') {
    void sendAction({ action: 'claim_request', agent: 'engineer' });
  } else if (capture === 'report') {
    dispatch({ type: 'claim_confirmed', agent: 'engineer', task_id: 'SIM-001', task_title: '模拟｜制作工作室领任务与验收界面', source: '模拟 COO' });
    dispatch({ type: 'report_ready', agent: 'engineer', task_id: 'SIM-001', report_local: '/sim-reports/SIM-001-report.md', summary: '模拟｜已完成双角色桌面、领取确认、阻塞举手与验收交互；本文件只是本地演示。' });
    hud.openReport();
  } else if (capture === 'offline') {
    dispatch({ type: 'bridge_status', mode: 'dry-run', connected: false, last_update_ts: now - 65_000, note: '模拟｜桥接断线证据' });
  } else if (params.has('simulate')) {
    void runDryRun(dispatch, { delayMs: 1400 });
  }

  // Read-only inspection handles for the local dry-run checks and captures.
  Object.assign(window, { __studio: studio, __studioHud: hud, __floor: world });
}
