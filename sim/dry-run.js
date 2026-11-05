// ENG-160 deterministic dry-run event source. No sockets, tokens or real systems.
export function createDryRunEvents(now = Date.now()) {
  return [
    { type: 'bridge_status', mode: 'dry-run', connected: true, last_update_ts: now, note: '模拟｜本地事件序列已连接', ts: now },
    { type: 'claim_rejected', agent: 'engineer', reason: '模拟｜COO 正在整理上一张工单，请稍后再领取', ts: now + 1 },
    { type: 'claim_confirmed', agent: 'engineer', task_id: 'SIM-001', task_title: '模拟｜制作工作室领任务与验收界面', source: '模拟 COO', ts: now + 2 },
    { type: 'blocked', agent: 'engineer', task_id: 'SIM-001', reason: '模拟｜等待确认报告摘要字段，未连接真实系统', ts: now + 3 },
    { type: 'report_ready', agent: 'engineer', task_id: 'SIM-001', report_local: '/sim-reports/SIM-001-report.md', summary: '模拟｜已完成双角色桌面、领取确认、阻塞举手与验收交互；本文件只是本地演示。', ts: now + 4 },
    { type: 'review_result', task_id: 'SIM-001', result: 'returned', note: '模拟｜请补充手机端空状态说明后再验收', ts: now + 5 },
  ];
}

export async function runDryRun(emit, { delayMs = 1200, now = Date.now() } = {}) {
  for (const event of createDryRunEvents(now)) {
    emit(event);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

const isCli = typeof process !== 'undefined' && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) {
  for (const event of createDryRunEvents()) console.log(`[模拟] ${event.type} ${JSON.stringify(event)}`);
  console.log('[模拟] 顺序完成：claim_rejected → claim_confirmed → blocked → report_ready → review_result；未连接任何真实系统。');
}
