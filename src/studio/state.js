// ENG-160 dry-run studio state. Deliberately separate from shared/protocol.js:
// no new event is accepted by, or changes the behaviour of, the existing server.

export function createStudioState() {
  return {
    bridge: { received: false, mode: 'dry-run', connected: null, lastUpdateTs: null, note: '模拟｜尚未收到桥接状态' },
    engineer: { taskId: null, taskTitle: '模拟｜等待领取任务', blocked: null, claimPending: false, lastRejection: null },
    reports: {},
    reportOrder: [],
    reviewPending: {},
    notice: '模拟｜点击 Engineer，选择「向 COO 领任务」',
    actions: [],
  };
}

export function applyStudioEvent(state, ev) {
  if (!ev || typeof ev !== 'object') return state;
  switch (ev.type) {
    case 'bridge_status':
      state.bridge = {
        received: true,
        mode: String(ev.mode || 'dry-run'),
        connected: ev.connected === true,
        lastUpdateTs: Number.isFinite(ev.last_update_ts) ? ev.last_update_ts : null,
        note: String(ev.note || '模拟｜桥接状态已更新'),
      };
      break;
    case 'claim_confirmed':
      if (ev.agent !== 'engineer') break;
      state.engineer.taskId = String(ev.task_id || 'SIM-001');
      state.engineer.taskTitle = String(ev.task_title || '模拟｜未命名工单');
      state.engineer.claimPending = false;
      state.engineer.lastRejection = null;
      state.engineer.blocked = null;
      state.notice = `模拟｜已领取 ${state.engineer.taskId} · ${state.engineer.taskTitle} · 来源 ${String(ev.source || '模拟 COO')}`;
      break;
    case 'claim_rejected':
      if (ev.agent !== 'engineer') break;
      state.engineer.claimPending = false;
      state.engineer.lastRejection = String(ev.reason || '模拟｜未提供原因');
      state.notice = `模拟｜领取被退回：${state.engineer.lastRejection}`;
      break;
    case 'blocked':
      if (ev.agent !== 'engineer') break;
      state.engineer.blocked = {
        taskId: String(ev.task_id || state.engineer.taskId || 'SIM-001'),
        reason: String(ev.reason || '模拟｜未提供阻塞原因'),
      };
      state.notice = `模拟｜Engineer 举手：${state.engineer.blocked.reason}`;
      break;
    case 'report_ready': {
      if (ev.agent !== 'engineer') break;
      const taskId = String(ev.task_id || state.engineer.taskId || 'SIM-001');
      if (!state.reports[taskId]) state.reportOrder.push(taskId);
      state.reports[taskId] = {
        taskId,
        status: 'ready',
        summary: String(ev.summary || '模拟｜没有摘要'),
        reportUrl: ev.report_url ? String(ev.report_url) : null,
        reportLocal: ev.report_local ? String(ev.report_local) : null,
        note: '',
      };
      delete state.reviewPending[taskId];
      state.notice = `模拟｜${taskId} 报告已放到 Engineer 桌上，待验收`;
      break;
    }
    case 'review_result': {
      const taskId = String(ev.task_id || '');
      const report = state.reports[taskId];
      if (!report) break;
      const approved = ['approved', 'accepted', 'pass', 'passed'].includes(String(ev.result).toLowerCase());
      delete state.reviewPending[taskId];
      report.note = String(ev.note || '模拟｜没有验收备注');
      if (approved) {
        delete state.reports[taskId];
        state.reportOrder = state.reportOrder.filter((id) => id !== taskId);
        state.notice = `模拟｜${taskId} 验收通过，文件已收回`;
      } else {
        report.status = 'rejected';
        state.notice = `模拟｜${taskId} 退回修改：${report.note}`;
      }
      break;
    }
  }
  return state;
}

/** Record the intent only. Confirmation events, never clicks, complete the work. */
export function beginStudioAction(state, payload) {
  const action = { ...payload, ts: Number.isFinite(payload.ts) ? payload.ts : Date.now() };
  state.actions.push(action);
  if (action.action === 'claim_request' && action.agent === 'engineer') {
    state.engineer.claimPending = true;
    state.notice = '模拟｜已送出领取请求，等待确认';
  }
  if (action.action === 'review' && action.task_id) {
    const taskId = String(action.task_id);
    state.reviewPending[taskId] = { result: String(action.result || ''), note: String(action.note || '') };
    state.notice = `模拟｜${taskId} 已送出，等待桥接确认`;
  }
  return action;
}

export function latestReport(state) {
  const id = state.reportOrder.at(-1);
  return id ? state.reports[id] : null;
}

export function bridgeView(state, now = Date.now()) {
  const b = state.bridge;
  if (!b.received) return { text: '模拟模式｜状态未知', stale: true, note: b.note };
  const stale = !b.connected || !b.lastUpdateTs || now - b.lastUpdateTs > 60_000;
  if (stale) {
    const time = b.lastUpdateTs
      ? new Date(b.lastUpdateTs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : '未知';
    return { text: `模拟模式｜资料过时／断线，最后更新 ${time}`, stale: true, note: b.note };
  }
  return { text: '模拟模式｜桥接已连接（本地模拟）', stale: false, note: b.note };
}

export class StudioStore {
  constructor() {
    this.state = createStudioState();
    this.listeners = new Set();
    this.eventListeners = new Set();
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onEvent(fn) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
  apply(ev) {
    applyStudioEvent(this.state, ev);
    for (const fn of this.eventListeners) fn(ev);
    this.emit();
  }
  beginAction(payload) {
    const action = beginStudioAction(this.state, payload);
    this.emit();
    return action;
  }
}
