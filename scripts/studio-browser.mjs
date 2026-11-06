// ENG-160 Chrome mobile-mode interaction checks + four evidence screenshots.
// Requires only the Vite server: npm exec vite -- --host 127.0.0.1 --port 5175
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:5175';
const out = path.resolve('docs/eng-160/evidence');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eng160-chrome-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9223', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let version;
  for (let i = 0; i < 40; i++) {
    try { version = await fetch('http://127.0.0.1:9223/json/version').then((r) => r.json()); break; } catch { await wait(150); }
  }
  if (!version) throw new Error('Chrome DevTools did not start');
  const target = await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(JSON.stringify(data.error))); else resolve(data.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const navigate = async (capture) => {
    await send('Page.navigate', { url: `${base}/?studio&capture=${capture}` });
    await wait(5500);
  };
  const click = async (selector) => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing ${selector}');const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await wait(150);
  };
  const shot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(result.data, 'base64'));
    console.log(`[模拟截图] ${name}.png`);
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await navigate('default');
  assert(await evaluate(`Object.keys(__studio.state.reports).length===0 && document.querySelectorAll('.studio-tag').length===2`), 'default must have two roles and no report');
  const defaultLayout = await evaluate(`({width:document.documentElement.scrollWidth,banner:document.querySelector('.studio-banner').getBoundingClientRect().toJSON(),tags:[...document.querySelectorAll('.studio-tag')].map(e=>({id:e.dataset.agent,visibility:getComputedStyle(e).visibility,...e.getBoundingClientRect().toJSON()}))})`);
  assert(defaultLayout.width === 390 && defaultLayout.banner.right <= 390, 'default horizontal overflow');
  assert(defaultLayout.tags.every((tag) => tag.visibility === 'visible' && tag.left >= 0 && tag.right <= 390 && tag.height >= 44), 'role tag clipped or below 44px');
  await shot('default');

  await click('[data-agent="engineer"]');
  assert(await evaluate(`document.querySelector('.studio-menu-wrap').classList.contains('show')`), 'Engineer menu did not open');
  assert(await evaluate(`document.querySelector('.studio-claim').getBoundingClientRect().height >= 44`), 'claim button below 44px');
  await click('.studio-claim');
  assert(await evaluate(`__studio.state.engineer.claimPending && __studio.state.engineer.taskId===null`), 'claim click must wait for confirmation');
  await shot('waiting');

  await evaluate(`__studio.apply({type:'claim_confirmed',agent:'engineer',task_id:'SIM-001',task_title:'模拟｜手机交互验收',source:'模拟 COO'});__studio.apply({type:'report_ready',agent:'engineer',task_id:'SIM-001',report_local:'/sim-reports/SIM-001-report.md',summary:'模拟｜手机模式坐标点击与验收状态检查。'})`);
  await wait(300);
  assert(await evaluate(`(()=>{const r=document.querySelector('.studio-file').getBoundingClientRect();return getComputedStyle(document.querySelector('.studio-file')).visibility==='visible'&&r.left>=0&&r.right<=390&&r.height>=44})()`), 'report file clipped or below 44px');
  await click('.studio-file');
  assert(await evaluate(`document.querySelector('.studio-modal-wrap').classList.contains('show')`), 'report did not open');
  await shot('report');
  const reportLayout = await evaluate(`({width:document.documentElement.scrollWidth,modal:document.querySelector('.studio-modal').getBoundingClientRect().toJSON(),buttons:[...document.querySelectorAll('.studio-modal button')].filter(e=>!e.classList.contains('studio-scrim')).map(e=>({c:e.className,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))})`);
  assert(reportLayout.width === 390 && reportLayout.modal.right <= 390, 'report modal overflow');
  assert(reportLayout.buttons.every((b) => b.w >= 44 && b.h >= 44), 'report button below 44px');
  await click('.studio-approve');
  assert(await evaluate(`__studio.state.reports['SIM-001'].status==='ready' && !!__studio.state.reviewPending['SIM-001']`), 'approval click changed report before confirmation');
  await evaluate(`__studio.apply({type:'review_result',task_id:'SIM-001',result:'approved',note:'模拟｜通过'})`);
  assert(await evaluate(`!__studio.state.reports['SIM-001']`), 'approved review_result should remove file');

  await evaluate(`__studio.apply({type:'report_ready',agent:'engineer',task_id:'SIM-001',summary:'模拟｜退回路径',report_local:'/sim-reports/SIM-001-report.md'});__studioHud.openReport()`);
  await click('.studio-return');
  assert(await evaluate(`__studio.state.reports['SIM-001'].status==='ready'`), 'return click changed report before confirmation');
  await evaluate(`__studio.apply({type:'review_result',task_id:'SIM-001',result:'returned',note:'模拟｜退回'});__studioHud.closeModal();__studio.apply({type:'blocked',agent:'engineer',task_id:'SIM-001',reason:'模拟｜阻塞原因检查'})`);
  assert(await evaluate(`__studio.state.reports['SIM-001'].status==='rejected'`), 'returned result should make file red');
  await click('[data-agent="engineer"]');
  assert(await evaluate(`document.querySelector('.studio-reason')?.textContent.includes('阻塞原因检查')`), 'blocked reason did not open');

  await evaluate(`__studioHud.closeModal();__studio.apply({type:'bridge_status',mode:'dry-run',connected:false,last_update_ts:Date.now()-65000,note:'模拟｜断线检查'})`);
  await wait(200);
  assert(await evaluate(`document.querySelector('.studio-bridge').textContent.includes('资料过时／断线')`), 'offline banner missing');
  await shot('offline');

  const origins = await evaluate(`[...new Set(performance.getEntriesByType('resource').map(e=>new URL(e.name).origin))]`);
  assert(origins.every((origin) => origin === new URL(base).origin), 'unexpected external resource');
  const report = { passed: true, viewport: '390x844', mobileEmulation: true, coordinateClicks: ['Engineer menu', 'claim_request', 'report file', 'approve', 'return', 'blocked reason'], externalOrigins: origins, screenshots: ['default.png', 'waiting.png', 'report.png', 'offline.png'] };
  fs.writeFileSync(path.join(out, 'browser-checks.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (ws) ws.close();
  chrome.kill('SIGTERM');
  fs.rmSync(profile, { recursive: true, force: true });
}
