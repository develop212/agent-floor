import type { Agent, WorldState } from '../../shared/protocol';
import type { ConnectionMode } from '../core/store';
import type { Anchor } from '../world/World';
import { looksFor, shirtFor, sourceLabel, STATUS_COLORS, STATUS_LABEL, teamAccent } from '../world/palette';
import { icon } from './icons';
import { Chat } from './chat';
import { REPO_URL } from '../config';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

interface Tag {
  root: HTMLDivElement;
  /** Last values written to the DOM, so unchanged frames cost nothing. */
  last: { t: string; o: string; z: string; near: boolean; sel: boolean };
  name: HTMLElement;
  role: HTMLElement;
  dot: HTMLElement;
  activity: HTMLElement;
  key: string;
}

interface Bubble {
  root: HTMLDivElement;
  until: number;
}

export interface HudActions {
  select(id: string | null): void;
  focusTeam(id: string): void;
  frameAll(): void;
  toggleTheme(): void;
  startDemo(): void;
  submitChat(prompt: string, onDelta: (chunk: string) => void): Promise<void>;
}

/** Statuses that mean "this agent is on the clock right now". */
const BUSY = new Set(['thinking', 'working', 'waiting', 'error']);
const BUSY_RANK: Record<string, number> = { waiting: 0, error: 0, working: 1, thinking: 2 };

/** Short label for a desk. Subagents show their type; the lead shows its project. */
function roleOf(a: Agent) {
  return (a.role || '').toLowerCase() === (a.name || '').toLowerCase()
    ? (a.parent ? a.role : '')
    : a.role || (a.parent ? 'Agent' : '');
}

const SETUP: Record<string, { title: string; steps: { label: string; code: string }[]; note: string }> = {
  claude: {
    title: 'Claude Code',
    steps: [
      { label: 'Install', code: 'npm i -g agent-floor' },
      { label: 'Add the hooks to ~/.claude/settings.json', code: 'agent-floor setup claude --write' },
    ],
    note: 'Agent Floor opens by itself when a session starts. Every session gets an office named after its project folder; subagents walk in, get briefed, and report back.',
  },
  codex: {
    title: 'Codex',
    steps: [
      { label: 'Install', code: 'npm i -g agent-floor' },
      { label: 'Print the notify line for ~/.codex/config.toml', code: 'agent-floor setup codex' },
    ],
    note: 'Codex reports at the end of each turn, so its desk updates once per reply.',
  },
  cursor: {
    title: 'Cursor',
    steps: [
      { label: 'Install', code: 'npm i -g agent-floor' },
      { label: 'Add the hooks to ~/.cursor/hooks.json', code: 'agent-floor setup cursor --write' },
    ],
    note: 'Agent Floor only listens. It never answers a permission prompt for you.',
  },
  http: {
    title: 'Anything else',
    steps: [
      { label: 'Start the floor', code: 'npx agent-floor' },
      {
        label: 'Post an event from any language',
        code: `curl -X POST localhost:4317/events \\\n  -H 'content-type: application/json' \\\n  -d '{"type":"tool","agent":"bot-1","team":"Payments","tool":"Bash","activity":"Running tests"}'`,
      },
    ],
    note: 'Events: join, status, tool, message, task, leave. See docs/protocol.md.',
  },
};

export class Hud {
  private root = el('div', 'hud');
  private tagsLayer = el('div', 'tags');
  private bubblesLayer = el('div', 'bubbles');
  private tags = new Map<string, Tag>();
  private bubbles = new Map<string, Bubble>();
  private modePill = el('div', 'mode');
  private demoNote = el('div', 'demo-note glass');
  private teamsDock = el('nav', 'teams glass');
  private busyPanel = el('section', 'busy glass');
  private busyBadge = el('span', 'busy-badge');
  private busyOpen = false;
  private busyKey = '';
  private chat: Chat;
  private card = el('aside', 'card glass');
  private sheet = el('div', 'sheet-wrap');
  private empty = el('div', 'empty glass');
  private themeBtn: HTMLButtonElement;
  private busyBtn: HTMLButtonElement;
  private teamsKey = '';
  private cardKey = '';
  private state: WorldState | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private mode: ConnectionMode = 'connecting';

  constructor(container: HTMLElement, private actions: HudActions) {
    this.chat = new Chat(actions.submitChat);
    this.root.append(this.tagsLayer, this.bubblesLayer);

    // Top bar
    const top = el('header', 'topbar');
    const brand = el('div', 'brand glass');
    brand.innerHTML = `<span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="brand-name">Agent Floor</span>`;
    brand.append(this.modePill);
    const tools = el('div', 'tools glass');
    const btn = (name: Parameters<typeof icon>[0], label: string, fn: () => void) => {
      const b = el('button', 'icon-btn', icon(name)) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.addEventListener('click', fn);
      tools.append(b);
      return b;
    };
    btn('cornersOut', 'Show everyone (F)', () => actions.frameAll());
    tools.append(this.chat.button);
    const busyBtn = btn('users', 'Who is working (W)', () => this.toggleBusy());
    busyBtn.append(this.busyBadge);
    this.busyBtn = busyBtn;
    this.themeBtn = btn('moon', 'Switch theme (T)', () => actions.toggleTheme());
    btn('plug', 'Connect your agents', () => this.openSheet());
    const gh = el('a', 'icon-btn', icon('github')) as HTMLAnchorElement;
    gh.href = REPO_URL;
    gh.target = '_blank';
    gh.rel = 'noreferrer';
    gh.setAttribute('aria-label', 'Source on GitHub');
    gh.title = 'Source on GitHub';
    tools.append(gh);
    top.append(brand, tools);

    this.demoNote.innerHTML = `<span>You are looking at a demo floor.</span>`;
    const connect = el('button', 'link-btn', 'Connect your agents') as HTMLButtonElement;
    connect.type = 'button';
    connect.addEventListener('click', () => this.openSheet());
    this.demoNote.append(connect);

    const hint = el('div', 'hint', '<span>Drag to pan</span><span>Right-drag to orbit</span><span>Scroll to zoom</span><span>Click anyone</span>');

    this.empty.innerHTML = `<h2>The floor is empty</h2><p>Start an agent with the hooks installed and it will walk in and take a desk.</p>`;
    const emptyActions = el('div', 'row');
    const e1 = el('button', 'btn primary', `${icon('plug')}<span>Connect</span>`) as HTMLButtonElement;
    e1.type = 'button';
    e1.addEventListener('click', () => this.openSheet());
    const e2 = el('button', 'btn', `${icon('play')}<span>Watch demo</span>`) as HTMLButtonElement;
    e2.type = 'button';
    e2.addEventListener('click', () => actions.startDemo());
    emptyActions.append(e1, e2);
    this.empty.append(emptyActions);

    this.card.setAttribute('aria-live', 'polite');
    this.buildSheet();
    this.root.append(top, this.demoNote, this.teamsDock, this.busyPanel, this.chat.rootEl, this.card, this.empty, hint, this.sheet);
    container.append(this.root);

    this.bindKeys();
  }

  // ---------------------------------------------------------------- state

  setTheme(dark: boolean) {
    this.themeBtn.innerHTML = icon(dark ? 'sun' : 'moon');
  }

  setMode(mode: ConnectionMode) {
    this.mode = mode;
    const label = { live: 'Live', demo: 'Demo', connecting: 'Connecting', offline: 'Offline' }[mode];
    this.modePill.className = `mode ${mode}`;
    this.modePill.innerHTML = `<span class="pulse" aria-hidden="true"></span>${label}`;
    this.root.classList.toggle('is-demo', mode === 'demo');
    this.updateEmpty();
  }

  setState(state: WorldState, selected: string | null) {
    this.state = state;
    this.selected = selected;
    this.renderTeams();
    this.renderBusy();
    this.renderCard();
    this.updateEmpty();
  }

  setHovered(id: string | null) {
    this.hovered = id;
  }

  private updateEmpty() {
    const count = this.state ? Object.keys(this.state.agents).length : 0;
    this.empty.classList.toggle('show', this.mode === 'live' && count === 0);
  }

  // ---------------------------------------------------------------- teams dock

  private renderTeams() {
    const s = this.state!;
    const teams = Object.values(s.teams).sort((a, b) => a.order - b.order);
    const counts = new Map<string, number>();
    const attention = new Map<string, boolean>();
    for (const a of Object.values(s.agents)) {
      counts.set(a.team, (counts.get(a.team) || 0) + 1);
      if (a.status === 'waiting' || a.status === 'error') attention.set(a.team, true);
    }
    const key = teams.map((t) => `${t.id}:${t.name}:${counts.get(t.id)}:${attention.get(t.id) ? 1 : 0}`).join('|');
    if (key === this.teamsKey) return;
    this.teamsKey = key;
    this.teamsDock.innerHTML = '';
    this.teamsDock.classList.toggle('show', teams.length > 0);
    for (const t of teams) {
      const b = el('button', 'team-chip') as HTMLButtonElement;
      b.type = 'button';
      b.innerHTML = `<span class="swatch" style="background:${teamAccent(t.hue).getStyle()}"></span><span class="team-name">${esc(t.name)}</span><span class="count">${counts.get(t.id) || 0}</span>${attention.get(t.id) ? '<span class="flag" title="Someone needs attention"></span>' : ''}`;
      b.addEventListener('click', () => this.actions.focusTeam(t.id));
      this.teamsDock.append(b);
    }
  }

  // ---------------------------------------------------------------- who is working

  private busyList(): Agent[] {
    const s = this.state!;
    return Object.values(s.agents)
      .filter((a) => BUSY.has(a.status))
      .sort(
        (a, b) =>
          (BUSY_RANK[a.status] ?? 9) - (BUSY_RANK[b.status] ?? 9) ||
          (s.teams[a.team]?.order ?? 0) - (s.teams[b.team]?.order ?? 0) ||
          b.lastSeen - a.lastSeen,
      )
      .slice(0, 40);
  }

  private toggleBusy() {
    this.busyOpen = !this.busyOpen;
    this.busyKey = '';
    if (this.busyOpen) this.renderBusy();
    this.busyPanel.classList.toggle('show', this.busyOpen);
    this.busyBtn.classList.toggle('active', this.busyOpen);
  }

  private closeBusy() {
    if (!this.busyOpen) return;
    this.busyOpen = false;
    this.busyKey = '';
    this.busyPanel.classList.remove('show');
    this.busyBtn.classList.remove('active');
  }

  private renderBusy() {
    const s = this.state;
    const busy = s ? this.busyList() : [];
    const n = busy.length;
    this.busyBadge.hidden = n === 0;
    this.busyBadge.textContent = String(n);
    if (!this.busyOpen || !s) return;
    const key = busy.map((a) => `${a.id}:${a.status}:${a.activity}:${a.lastSeen}`).join('|') + '|' + this.selected;
    if (key === this.busyKey) return;
    this.busyKey = key;
    this.busyPanel.innerHTML = `
      <div class="busy-head">
        <h2>Working now</h2>
        <button type="button" class="icon-btn close" aria-label="Close">${icon('x')}</button>
      </div>
      ${
        n
          ? `<ul class="busy-list">${busy
              .map(
                (agent) =>
                  `<li><button type="button" class="busy-row${agent.id === this.selected ? ' selected' : ''}" data-id="${esc(agent.id)}">
                    <span class="dot" style="background:${STATUS_COLORS[agent.status]}"></span>
                    <span class="busy-who"><b>${esc(agent.name)}</b><span class="busy-meta">${esc(roleOf(agent))}${
                      agent.activity ? ` · ${esc(agent.activity)}` : ''
                    }</span></span>
                    <span class="busy-when">${ago(agent.lastSeen)}</span>
                  </button></li>`,
              )
              .join('')}</ul>`
          : `<p class="busy-none">Nobody is on the clock. Agents appear here the moment they start.</p>`
      }`;
    this.busyPanel.querySelector('.close')!.addEventListener('click', () => this.closeBusy());
    this.busyPanel.querySelectorAll<HTMLButtonElement>('.busy-row').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions.select(b.dataset.id!);
        this.closeBusy();
      });
    });
  }

  // ---------------------------------------------------------------- agent card

  private renderCard() {
    const s = this.state!;
    const a = this.selected ? s.agents[this.selected] : undefined;
    if (!a) {
      this.card.classList.remove('show');
      this.cardKey = '';
      return;
    }
    const key = `${a.id}|${a.status}|${a.activity}|${a.history.length}|${a.history.at(-1)?.ts}|${Math.floor(Date.now() / 10000)}`;
    if (key === this.cardKey) return;
    this.cardKey = key;
    const team = s.teams[a.team];
    const parent = a.parent ? s.agents[a.parent] : undefined;
    const crew = Object.values(s.agents).filter((x) => x.parent === a.id);
    const hist = [...a.history].reverse().slice(0, 7);
    const color = STATUS_COLORS[a.status];
    const look = looksFor(a.id);

    this.card.innerHTML = `
      <div class="card-head">
        <span class="avatar" style="--shirt:${shirtFor(a.role)};--skin:${look.skin};--hair:${look.hair}" aria-hidden="true"><i></i></span>
        <div class="who">
          <h2>${esc(a.name)}</h2>
          <p>${esc(a.role)} in ${esc(team?.name || a.team)}</p>
        </div>
        <button type="button" class="icon-btn close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="status-row">
        <span class="status-chip" style="--c:${color}"><span class="dot"></span>${STATUS_LABEL[a.status]}</span>
        <span class="source">${esc(sourceLabel(a.source))}</span>
      </div>
      <div class="now">
        <p class="now-text">${esc(a.activity || 'Nothing yet')}</p>
        ${a.tool ? `<p class="now-tool">${esc(a.tool)}</p>` : ''}
      </div>
      ${
        parent || crew.length
          ? `<div class="links">${parent ? `<button type="button" class="person" data-id="${esc(parent.id)}">Reports to ${esc(parent.name)}</button>` : ''}${crew
              .map((c) => `<button type="button" class="person" data-id="${esc(c.id)}"><span class="mini-dot" style="background:${STATUS_COLORS[c.status]}"></span>${esc(c.name)}</button>`)
              .join('')}</div>`
          : ''
      }
      <ol class="history">
        ${hist
          .map(
            (h) =>
              `<li><span class="h-kind k-${h.kind}"></span><span class="h-text">${esc(h.kind === 'message' ? `Said "${h.text}"` : h.text)}</span><time>${ago(h.ts)}</time></li>`,
          )
          .join('')}
      </ol>`;
    this.card.querySelector('.close')!.addEventListener('click', () => this.actions.select(null));
    this.card.querySelectorAll<HTMLButtonElement>('.person').forEach((b) => b.addEventListener('click', () => this.actions.select(b.dataset.id!)));
    this.card.classList.add('show');
  }

  // ---------------------------------------------------------------- tags & bubbles (every frame)

  frame(anchors: Anchor[]) {
    const s = this.state;
    if (!s) return;
    const seen = new Set<string>();
    for (const an of anchors) {
      const agent = s.agents[an.id];
      if (!agent) continue;
      seen.add(an.id);
      let tag = this.tags.get(an.id);
      if (!tag) tag = this.makeTag(agent);
      this.updateTag(tag, agent);
      const near = an.depth < 15 || an.id === this.hovered || an.id === this.selected;
      const sel = an.id === this.selected;
      const show = an.visible && (an.depth < 70 || sel);
      const L = tag.last;
      const o = show ? '1' : '0';
      if (o !== L.o) {
        tag.root.style.opacity = o;
        tag.root.style.visibility = show ? '' : 'hidden';
        L.o = o;
      }
      if (show) {
        const scale = Math.max(0.62, Math.min(1, 16 / an.depth));
        const t = `translate3d(${an.x.toFixed(1)}px, ${an.y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
        if (t !== L.t) {
          tag.root.style.transform = t;
          L.t = t;
        }
        const z = String(1000 - Math.round(an.depth * 4));
        if (z !== L.z) {
          tag.root.style.zIndex = z;
          L.z = z;
        }
      }
      if (near !== L.near) {
        tag.root.classList.toggle('near', near);
        L.near = near;
      }
      if (sel !== L.sel) {
        tag.root.classList.toggle('selected', sel);
        L.sel = sel;
      }
      const scale = Math.max(0.62, Math.min(1, 16 / an.depth));

      const bubble = this.bubbles.get(an.id);
      if (bubble) {
        const lift = near ? 66 : 44;
        bubble.root.style.transform = `translate3d(${an.x.toFixed(1)}px, ${(an.y - lift * scale).toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
        bubble.root.style.opacity = show ? '' : '0';
        bubble.root.style.zIndex = String(2000 - Math.round(an.depth * 10));
      }
    }
    for (const [id, tag] of this.tags) {
      if (!seen.has(id)) {
        tag.root.remove();
        this.tags.delete(id);
      }
    }
    const now = performance.now();
    for (const [id, b] of this.bubbles) {
      if (now > b.until || !seen.has(id)) {
        b.root.classList.add('out');
        const r = b.root;
        setTimeout(() => r.remove(), 260);
        this.bubbles.delete(id);
      }
    }
  }

  private makeTag(agent: Agent): Tag {
    const root = el('div', 'tag');
    root.innerHTML = `<div class="tag-line"><span class="dot"></span><b></b><span class="role"></span></div><div class="activity"></div>`;
    root.addEventListener('click', () => this.actions.select(agent.id));
    this.tagsLayer.append(root);
    const tag: Tag = {
      root,
      name: root.querySelector('b')!,
      role: root.querySelector('.role')!,
      dot: root.querySelector('.dot')!,
      activity: root.querySelector('.activity')!,
      key: '',
      last: { t: '', o: '', z: '', near: false, sel: false },
    };
    this.tags.set(agent.id, tag);
    return tag;
  }

  private updateTag(tag: Tag, a: Agent) {
    const key = `${a.name}|${a.role}|${a.status}|${a.activity}`;
    if (key === tag.key) return;
    tag.key = key;
    tag.name.textContent = a.name;
    tag.role.textContent = a.role.toLowerCase() === a.name.toLowerCase() ? '' : a.role;
    tag.dot.style.background = STATUS_COLORS[a.status];
    tag.root.dataset.status = a.status;
    tag.activity.textContent = a.activity || STATUS_LABEL[a.status];
  }

  say(id: string, text: string, toName?: string) {
    if (!text) return;
    let b = this.bubbles.get(id);
    if (!b) {
      const root = el('div', 'bubble') as HTMLDivElement;
      this.bubblesLayer.append(root);
      b = { root, until: 0 };
      this.bubbles.set(id, b);
    }
    b.root.innerHTML = `${toName ? `<span class="to">To ${esc(toName)}</span>` : ''}<span class="said">${esc(text)}</span>`;
    b.root.classList.remove('out');
    // Restart the entrance animation for a fresh line.
    b.root.classList.remove('in');
    void b.root.offsetWidth;
    b.root.classList.add('in');
    b.until = performance.now() + Math.min(6500, 2600 + text.length * 45);
  }

  // ---------------------------------------------------------------- connect sheet

  private buildSheet() {
    this.sheet.innerHTML = `
      <div class="scrim"></div>
      <section class="sheet glass" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet-head">
          <h2 id="sheet-title">Connect your agents</h2>
          <button type="button" class="icon-btn close" aria-label="Close">${icon('x')}</button>
        </div>
        <p class="sheet-lede">Agent Floor runs on your machine. Your agents report what they are doing through hooks, and nothing leaves localhost.</p>
        <div class="tabs" role="tablist">
          ${Object.entries(SETUP)
            .map(([k, v], i) => `<button type="button" role="tab" class="tab${i === 0 ? ' active' : ''}" data-tab="${k}" aria-selected="${i === 0}">${v.title}</button>`)
            .join('')}
        </div>
        <div class="tab-body"></div>
      </section>`;
    const body = this.sheet.querySelector<HTMLDivElement>('.tab-body')!;
    const show = (k: string) => {
      const v = SETUP[k];
      body.innerHTML = `${v.steps
        .map(
          (s) => `<div class="step"><p>${esc(s.label)}</p><div class="code"><pre><code>${esc(s.code)}</code></pre><button type="button" class="icon-btn copy" aria-label="Copy">${icon('copy')}</button></div></div>`,
        )
        .join('')}<p class="note">${esc(v.note)}</p>`;
      body.querySelectorAll<HTMLButtonElement>('.copy').forEach((b) =>
        b.addEventListener('click', async () => {
          const code = b.parentElement!.querySelector('code')!.textContent || '';
          try {
            await navigator.clipboard.writeText(code);
            b.innerHTML = icon('check');
            setTimeout(() => (b.innerHTML = icon('copy')), 1400);
          } catch {
            /* clipboard blocked: the text is still selectable */
          }
        }),
      );
      this.sheet.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === k);
        t.setAttribute('aria-selected', String(t.dataset.tab === k));
      });
    };
    show('claude');
    this.sheet.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab!)));
    this.sheet.querySelector('.close')!.addEventListener('click', () => this.closeSheet());
    this.sheet.querySelector('.scrim')!.addEventListener('click', () => this.closeSheet());
  }

  openSheet() {
    this.sheet.classList.add('show');
    this.sheet.querySelector<HTMLButtonElement>('.tab.active')?.focus();
  }

  closeSheet() {
    this.sheet.classList.remove('show');
  }

  // ---------------------------------------------------------------- keys

  private bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (this.sheet.classList.contains('show')) this.closeSheet();
        else if (this.busyOpen) this.closeBusy();
        else if (this.chat.isOpen) this.chat.toggle(false);
        else this.actions.select(null);
      } else if (e.key === 'f' || e.key === 'F') this.actions.frameAll();
      else if (e.key === 't' || e.key === 'T') this.actions.toggleTheme();
      else if (e.key === 'w' || e.key === 'W') this.toggleBusy();
      else if (e.key === 'c' || e.key === 'C') this.chat.toggle();
      else if (e.key === ']' || e.key === '[') {
        const ids = Object.values(this.state?.agents || {})
          .sort((a, b) => (this.state!.teams[a.team]?.order ?? 0) - (this.state!.teams[b.team]?.order ?? 0) || a.joinedAt - b.joinedAt)
          .map((a) => a.id);
        if (!ids.length) return;
        const i = this.selected ? ids.indexOf(this.selected) : -1;
        const next = ids[(i + (e.key === ']' ? 1 : -1) + ids.length) % ids.length];
        this.actions.select(next);
      }
    });
  }
}
