# ENG-160-UI — MSOS 工作室 dry-run 前端

## STATUS

DONE（前端 dry-run）。基线 `main@c5422bb`，分支 `kimi/studio-ui`。未连接任何真实系统，未修改 Agent Floor server、`shared/protocol.js`、bridge 或 arthur-os。

## 现有事件类型与状态机

- 原协议只接受 `join / status / tool / message / task / leave / reset`；未知事件由 `normalizeEvent()` 丢弃。
- `join` 建立团队、角色与座位；`status` 更新 `idle / thinking / working / waiting / done / error / offline`；`tool` 默认令角色进入 `working`；`message` 产生角色间消息效果；`task` 更新团队任务；`leave` 转为 `offline`；`reset` 清空世界。
- `POST /events` 规范化并应用事件；`GET /stream` 先发送 `snapshot`，随后持续发送 `event + effects`，清理角色时发送 `removed`。本轮没有改这些行为。

## 新增 dry-run 事件（给 Engineer 对接）

这些事件目前只由 `src/studio/state.js` 的独立前端状态机消费，不是原 server 协议：

| 事件 | 字段 | 前端结果 |
| --- | --- | --- |
| `claim_confirmed` | `agent, task_id, task_title, source` | Engineer 走到 COO 桌前再回座位，名牌显示工单名 |
| `claim_rejected` | `agent, reason` | 保留并显示领取被拒原因 |
| `blocked` | `agent, task_id, reason` | Engineer 举手；点击角色只看原因，不清除标记 |
| `report_ready` | `agent, task_id, report_url \| report_local, summary` | 桌上出现文件，状态为待验收 |
| `review_result` | `task_id, result, note` | 通过后文件消失；退回后文件变红 |
| `bridge_status` | `mode, connected, last_update_ts, note` | 更新持续横幅；断线或超过 60 秒显示过时，未收到则显示状态未知 |

本地动作意图为 `POST /actions` 形状：`claim_request {action, agent, ts}` 与 `review {action, task_id, result, note, ts}`。`src/studio/transport.ts` 用本地 handler 返回 202，请求不会发出网络；点击只进入等待状态，必须由上述确认事件完成状态变更。

## CHANGED

- `src/main.ts`：仅在 `?studio` 动态加载独立工作室，不改变原入口。
- `src/studio/boot.ts`：建立 COO／Engineer 两席、连接 dry-run 状态机与场景。
- `src/studio/state.js`、`state.d.ts`：实现领取、阻塞、报告、验收与桥接横幅状态。
- `src/studio/transport.ts`：本地 mock `/actions` handler，记录请求意图，不发送网络。
- `src/studio/StudioHud.ts`、`studio.css`：双角色名牌、菜单、桌上文件、报告 modal、按钮与持续状态横幅。
- `src/world/Character.ts`：增加 `visit()` 往返走位。
- `src/world/Workstation.ts`：增加默认隐藏的报告文件及退回红色状态。
- `src/world/World.ts`：增加工作室取景、Engineer 往返 COO、报告与桌面锚点；原 reducer 和 server 不变。
- `sim/dry-run.js`、`dry-run.d.ts`：按固定顺序发送全部模拟事件，含一次拒绝与一次阻塞。
- `public/sim-reports/SIM-001-report.md`：本地模拟报告。
- `test/studio.test.mjs`：新增 7 项状态机与协议隔离测试。
- `scripts/studio-browser.mjs`：Chrome CDP 390×844 手机模式真实坐标验收与截图。
- `docs/eng-160/evidence/`：四张截图、浏览器验收 JSON、模拟器终端输出。

## TESTED

- `npm test`：17/17 PASS（原测试 10 项＋新增 7 项）。
- `npm run build`：TypeScript 检查与 Vite production build PASS。
- `node sim/dry-run.js`：输出 `bridge_status → claim_rejected → claim_confirmed → blocked → report_ready → review_result`，全部标为模拟。
- `node scripts/studio-browser.mjs`：PASS；390×844、mobile emulation、真实坐标点击。覆盖 Engineer 菜单、领取等待确认、文件打开、验收通过、退回修改、阻塞原因、断线横幅；检查角色名牌和按钮可见、点击区至少 44px、无横向溢出、无外部资源来源。

## 证据

- `default.png`：默认只有 COO 与 Engineer 两席。
- `waiting.png`：领取请求已送出但仍等待确认。
- `report.png`：桌上报告打开，摘要、链接与验收按钮可见。
- `offline.png`：资料过时／断线横幅与退回文件。
- `browser-checks.json`：手机坐标验收结果。
- `simulator-output.txt`：模拟器终端输出。

## 本地运行

```bash
npm exec vite -- --host 127.0.0.1 --port 5175
# 打开 http://127.0.0.1:5175/?studio
# 自动播放： http://127.0.0.1:5175/?studio&simulate
node sim/dry-run.js
```

## 未接真实系统／边界

- 只完成画面、独立状态机与本地 dry-run 事件流；没有接 Notion、真实 COO、真实工单、真实 `/actions`、SSE 或 bridge。
- 没有 token、真实工单编号或真实报告链接；唯一编号为 `SIM-001`。
- 没有启动或修改 Agent Floor server；没有要求 Electron；没有改 `~/msos-studio/bridge/` 或 arthur-os。
- Engineer 对接时需在桥接层把真实确认结果映射为新增事件，并把本地 action handler 换成受控传输；在此之前「已送出」绝不代表「已完成」。
