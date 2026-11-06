import type { Anchor } from '../world/World';
import { bridgeView, latestReport, StudioStore, type StudioReport } from './state';

function esc(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

interface StudioHudActions {
  claim(): void;
  review(taskId: string, result: 'approved' | 'returned', note: string): void;
}

type ModalKind = 'coo' | 'blocked' | 'report' | null;

export class StudioHud {
  private root = document.createElement('div');
  private banner = document.createElement('div');
  private notice = document.createElement('div');
  private tags = new Map<string, HTMLButtonElement>();
  private file = document.createElement('button');
  private menu = document.createElement('div');
  private modal = document.createElement('div');
  private modalKind: ModalKind = null;

  constructor(container: HTMLElement, private studio: StudioStore, private actions: StudioHudActions) {
    this.root.className = 'studio-hud';
    this.banner.className = 'studio-banner';
    this.banner.innerHTML = '<div class="studio-brand"><strong>MSOS 工作室</strong><span>Agent Floor · dry-run</span></div><div class="studio-bridge" role="status"></div>';
    this.notice.className = 'studio-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');

    const tagLayer = document.createElement('div');
    tagLayer.className = 'studio-tags';
    for (const [id, name, role] of [['coo', 'COO', '任务与验收'], ['engineer', 'Engineer', '执行与报告']]) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'studio-tag';
      tag.dataset.agent = id;
      tag.innerHTML = `<span class="studio-tag-top"><b>${name}</b><i>${role}</i></span><span class="studio-task"></span>`;
      tag.addEventListener('click', () => this.openAgent(id));
      tagLayer.append(tag);
      this.tags.set(id, tag);
    }

    this.file.type = 'button';
    this.file.className = 'studio-file';
    this.file.addEventListener('click', () => this.openReport());
    this.file.innerHTML = '<span aria-hidden="true">▤</span><span class="studio-file-copy"></span>';

    this.menu.className = 'studio-menu-wrap';
    this.menu.innerHTML = '<button class="studio-scrim" type="button" aria-label="关闭菜单"></button><section class="studio-menu" role="dialog" aria-modal="true" aria-labelledby="studio-menu-title"><span class="studio-kicker">Engineer</span><h2 id="studio-menu-title">要做什么？</h2><button type="button" class="studio-primary studio-claim">向 COO 领任务</button><p class="studio-menu-reason"></p><button type="button" class="studio-secondary studio-menu-close">关闭</button></section>';
    this.menu.querySelector('.studio-claim')!.addEventListener('click', () => { this.actions.claim(); this.closeMenu(); });
    this.menu.querySelector('.studio-menu-close')!.addEventListener('click', () => this.closeMenu());
    this.menu.querySelector('.studio-scrim')!.addEventListener('click', () => this.closeMenu());

    this.modal.className = 'studio-modal-wrap';
    this.root.append(this.banner, tagLayer, this.file, this.notice, this.menu, this.modal);
    container.append(this.root);
    this.studio.subscribe(() => this.render());
    addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.closeMenu();
      this.closeModal();
    });
    this.render();
  }

  tick() {
    const view = bridgeView(this.studio.state);
    const bridge = this.banner.querySelector<HTMLElement>('.studio-bridge')!;
    bridge.textContent = view.text;
    bridge.classList.toggle('stale', view.stale);
    this.banner.title = view.note;
  }

  private render() {
    const state = this.studio.state;
    this.tick();
    this.notice.textContent = state.notice;
    const engineer = this.tags.get('engineer')!;
    engineer.querySelector('.studio-task')!.textContent = state.engineer.blocked
      ? '举手 · 点击查看阻塞原因'
      : state.engineer.claimPending
        ? '已送出领取请求，等待确认'
        : state.engineer.taskTitle;
    engineer.classList.toggle('blocked', Boolean(state.engineer.blocked));
    engineer.classList.toggle('pending', state.engineer.claimPending);
    this.tags.get('coo')!.querySelector('.studio-task')!.textContent = state.engineer.taskId ? `模拟工单 ${state.engineer.taskId}` : '模拟派单与验收';

    const claim = this.menu.querySelector<HTMLButtonElement>('.studio-claim')!;
    claim.disabled = state.engineer.claimPending;
    claim.textContent = state.engineer.claimPending ? '已送出领取请求，等待确认' : '向 COO 领任务';
    this.menu.querySelector<HTMLElement>('.studio-menu-reason')!.textContent = state.engineer.lastRejection || '';
    this.renderFile();
    this.renderModal();
  }

  private renderFile() {
    const report = latestReport(this.studio.state);
    this.file.classList.toggle('show', Boolean(report));
    this.file.classList.toggle('rejected', report?.status === 'rejected');
    if (!report) return;
    this.file.querySelector('.studio-file-copy')!.textContent = report.status === 'rejected'
      ? `${report.taskId} · 退回修改`
      : `${report.taskId} · 模拟报告 · 待验收`;
    this.file.setAttribute('aria-label', `打开 ${report.taskId} 模拟报告`);
  }

  frame(anchors: Anchor[], reportAnchor: Anchor | null) {
    const stageTop = 78;
    const safeX = (x: number, element: HTMLElement) => {
      const half = element.offsetWidth / 2;
      return Math.max(half + 8, Math.min(this.root.clientWidth - half - 8, x));
    };
    for (const anchor of anchors) {
      const tag = this.tags.get(anchor.id);
      if (!tag) continue;
      tag.style.transform = `translate3d(${safeX(anchor.x, tag)}px,${anchor.y + stageTop}px,0) translate(-50%,-100%)`;
      tag.style.visibility = anchor.visible ? 'visible' : 'hidden';
      tag.style.zIndex = String(1000 - Math.round(anchor.depth * 4));
    }
    if (reportAnchor) {
      this.file.style.transform = `translate3d(${safeX(reportAnchor.x, this.file)}px,${reportAnchor.y + stageTop}px,0) translate(-50%,-50%)`;
      this.file.style.visibility = reportAnchor.visible ? 'visible' : 'hidden';
    }
  }

  openAgent(id: string) {
    if (id === 'coo') this.modalKind = 'coo';
    else if (id === 'engineer' && this.studio.state.engineer.blocked) this.modalKind = 'blocked';
    else if (id === 'engineer') {
      this.menu.classList.add('show');
      this.menu.querySelector<HTMLButtonElement>('.studio-claim')!.focus();
      return;
    }
    this.renderModal();
    this.modal.querySelector<HTMLButtonElement>('button')?.focus();
  }

  openReport() {
    if (!latestReport(this.studio.state)) return;
    this.modalKind = 'report';
    this.renderModal();
    this.modal.querySelector<HTMLButtonElement>('.studio-close')?.focus();
  }

  private closeMenu() { this.menu.classList.remove('show'); }
  private closeModal() { this.modalKind = null; this.renderModal(); }

  private renderModal() {
    if (this.modalKind === 'report' && !latestReport(this.studio.state)) this.modalKind = null;
    this.modal.classList.toggle('show', Boolean(this.modalKind));
    if (!this.modalKind) { this.modal.innerHTML = ''; return; }
    const close = '<button type="button" class="studio-close" aria-label="关闭">×</button>';
    let body = '';
    if (this.modalKind === 'coo') {
      body = `${close}<span class="studio-kicker">COO · 模拟角色</span><h2>任务与验收</h2><p>模拟｜COO 负责确认领取与验收结果。此页面不会连接真实 COO 系统。</p>`;
    } else if (this.modalKind === 'blocked') {
      const blocked = this.studio.state.engineer.blocked!;
      body = `${close}<span class="studio-kicker">${esc(blocked.taskId)} · 模拟阻塞</span><h2>Engineer 举手了</h2><p class="studio-reason">${esc(blocked.reason)}</p><p class="studio-help">关闭窗口不会清除未解决标记；需由后续 dry-run 事件处理。</p>`;
    } else {
      const report = latestReport(this.studio.state)!;
      body = this.reportBody(report);
    }
    this.modal.innerHTML = `<button class="studio-scrim" type="button" aria-label="关闭"></button><section class="studio-modal" role="dialog" aria-modal="true">${body}</section>`;
    this.modal.querySelectorAll('.studio-scrim,.studio-close').forEach((button) => button.addEventListener('click', () => this.closeModal()));
    if (this.modalKind === 'report') this.bindReview();
  }

  private reportBody(report: StudioReport) {
    const pending = this.studio.state.reviewPending[report.taskId];
    const link = report.reportLocal
      ? `<a class="studio-report-link" href="${esc(report.reportLocal)}" target="_blank" rel="noreferrer">打开本地模拟报告</a>`
      : report.reportUrl
        ? `<a class="studio-report-link" href="${esc(report.reportUrl)}" target="_blank" rel="noreferrer">打开模拟报告链接</a>`
        : '<span class="studio-help">模拟｜未提供报告链接</span>';
    return `<button type="button" class="studio-close" aria-label="关闭">×</button><span class="studio-kicker">${esc(report.taskId)} · ${report.status === 'rejected' ? '模拟退回' : '待验收'}</span><h2>桌上报告</h2><p class="studio-summary">${esc(report.summary)}</p>${link}${report.note ? `<p class="studio-reason">${esc(report.note)}</p>` : ''}<label class="studio-note-label" for="review-note">验收备注（模拟）</label><textarea id="review-note" rows="3">${esc(pending?.note || '')}</textarea><p class="studio-pending">${pending ? '已送出，等待桥接确认' : '只有收到 review_result 才会改变文件状态'}</p><div class="studio-review-actions"><button type="button" class="studio-approve" ${pending ? 'disabled' : ''}>验收通过</button><button type="button" class="studio-return" ${pending ? 'disabled' : ''}>退回修改</button></div>`;
  }

  private bindReview() {
    const report = latestReport(this.studio.state);
    if (!report) return;
    const note = this.modal.querySelector<HTMLTextAreaElement>('#review-note')!;
    this.modal.querySelector('.studio-approve')?.addEventListener('click', () => this.actions.review(report.taskId, 'approved', note.value || '模拟｜验收通过'));
    this.modal.querySelector('.studio-return')?.addEventListener('click', () => this.actions.review(report.taskId, 'returned', note.value || '模拟｜退回修改'));
  }
}
