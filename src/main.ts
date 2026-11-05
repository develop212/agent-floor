import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { connect, isDemoRunning, startDemo } from './core/connection';
import { store } from './core/store';
import { Hud } from './ui/hud';
import { World } from './world/World';
import type { ThemeName } from './world/palette';

const app = document.getElementById('app')!;
// Running inside the desktop app window (Electron or a Chromium app window).
if (new URLSearchParams(location.search).has('app')) {
  document.documentElement.classList.add('in-app');
  if (/Mac/.test(navigator.platform)) document.documentElement.classList.add('in-app-mac');
}
const stage = document.createElement('div');
stage.className = 'stage';
app.append(stage);

// ---------------------------------------------------------------- theme
const THEME_KEY = 'agent-floor:theme';
function savedTheme(): ThemeName | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let theme: ThemeName = savedTheme() || (systemDark.matches ? 'dark' : 'light');

async function boot() {
  if (new URLSearchParams(location.search).has('studio')) {
    const { bootStudio } = await import('./studio/boot');
    await bootStudio(app, stage);
    return;
  }
  // Canvas textures draw text, so the fonts must be ready first.
  await Promise.race([
    Promise.all([document.fonts.load('600 24px "Geist Variable"'), document.fonts.load('500 20px "Geist Mono Variable"')]),
    new Promise((r) => setTimeout(r, 1500)),
  ]);

  const world = new World(stage, {
    onPick(agentId, teamId) {
      if (agentId) store.select(agentId);
      else if (teamId) {
        store.select(null);
        world.focusTeam(teamId);
      } else store.select(null);
    },
    onHover(id) {
      hud.setHovered(id);
    },
    onMessage(from, to, text) {
      const target = store.state.agents[to];
      hud.say(from, text, target?.name);
    },
  });

  const hud = new Hud(app, {
    select: (id) => store.select(id),
    focusTeam: (id) => world.focusTeam(id),
    frameAll: () => world.frameAll(),
    toggleTheme: () => applyTheme(theme === 'dark' ? 'light' : 'dark', true),
    startDemo: () => {
      if (!isDemoRunning()) startDemo();
    },
  });

  function applyTheme(next: ThemeName, persist = false) {
    theme = next;
    document.documentElement.dataset.theme = next;
    world.setTheme(next);
    hud.setTheme(next === 'dark');
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* storage unavailable: theme still applies for this visit */
      }
    }
  }
  applyTheme(theme);
  systemDark.addEventListener('change', (e) => {
    if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light');
  });

  let lastSelected: string | null = null;
  store.onEffect((e) => world.handleEffect(e));
  store.subscribe(() => {
    world.sync(store.state);
    if (store.selected !== lastSelected) {
      lastSelected = store.selected;
      world.setSelected(store.selected);
    }
    hud.setMode(store.mode);
    hud.setState(store.state, store.selected);
  });
  world.onFrame = () => hud.frame(world.anchors());
  // Refresh relative times on the card.
  setInterval(() => hud.setState(store.state, store.selected), 5000);

  hud.setMode(store.mode);
  connect();

  // ?stats shows a small performance readout (for contributors and bug reports).
  if (new URLSearchParams(location.search).has('stats')) {
    const box = document.createElement('pre');
    box.className = 'stats';
    document.body.append(box);
    // Handles for scripted captures (scripts/capture.cjs, scripts/record.cjs).
    Object.assign(window, { __floor: world, __store: store, __hud: hud });
    setInterval(() => {
      const p = world.perf;
      box.textContent = `${p.fps.toFixed(0)} fps  cpu ${p.frameMs.toFixed(1)} ms\n${p.calls} draws  ${(p.triangles / 1000).toFixed(0)}k tris\n${p.agents} agents  sync ${p.syncMs.toFixed(1)} ms (worst ${p.worstSyncMs.toFixed(0)})`;
    }, 500);
  }
}

boot();
