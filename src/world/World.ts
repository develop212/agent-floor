import {
  ACESFilmicToneMapping,
  Frustum,
  Matrix4,
  CanvasTexture,
  DirectionalLight,
  Fog,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  PCFSoftShadowMap,
  PointLight,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Agent, Effect, WorldState } from '../../shared/protocol';
import { Character, findAgentId, PICK_LAYER } from './Character';
import { Courier } from './Courier';
import { computeLayout, SeatBook, type BuildingLayout, type RoomLayout } from './layout';
import { Building } from './Building';
import { setNightGlow } from './props';
import { applyThemeToMaterials } from './materials';
import { prefersReducedMotion } from './motion';
import { REC } from './quality';
import { PALETTES, teamAccent, type ThemeName } from './palette';
import { TeamRoom } from './TeamRoom';
import { setDeskLamps, Workstation } from './Workstation';

interface Seated {
  character: Character;
  desk: Workstation;
  team: string;
  leaving: boolean;
}

export interface Anchor {
  id: string;
  x: number;
  y: number;
  depth: number;
  visible: boolean;
}

export interface WorldCallbacks {
  onPick(agentId: string | null, teamId: string | null): void;
  onHover(agentId: string | null): void;
  onMessage(from: string, to: string, text: string): void;
}

function findTeamId(o: Object3D | null): string | undefined {
  while (o) {
    if (o.userData.teamId) return o.userData.teamId as string;
    o = o.parent;
  }
  return undefined;
}

export class World {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(34, 1, 0.1, 400);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private hemi = new HemisphereLight();
  private sun = new DirectionalLight();
  private ground: Mesh;
  private groundMat: MeshStandardMaterial;
  private courier = new Courier();
  private rooms = new Map<string, TeamRoom>();
  private agents = new Map<string, Seated>();
  private plan: BuildingLayout | null = null;
  private building = new Building();

  /** The building's outline, the thing the camera frames. */
  private footprint() {
    const p = this.plan;
    if (!p) return { cx: 0, cz: 0, w: 30, d: 20 };
    return { cx: (p.x0 + p.x1) / 2, cz: (p.z0 + p.z1) / 2, w: p.x1 - p.x0, d: p.z1 - p.z0 };
  }

  private get layout(): Map<string, RoomLayout> {
    return this.plan?.rooms ?? new Map();
  }
  private book = new SeatBook();
  private state: WorldState | null = null;
  private studioReport: 'ready' | 'rejected' | null = null;
  private theme: ThemeName = 'light';
  private reduced = prefersReducedMotion();
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private pointerDirty = false;
  private downAt = new Vector2();
  private hovered: string | null = null;
  private selected: string | null = null;
  private last = performance.now();
  private elapsed = 0;
  private instantNext = true;
  private flight: { target: Vector3; position: Vector3; follow: string | null } | null = null;
  /** Camera flight velocities. Kept across re-targets so a new flight continues the motion. */
  private flightVel = { target: new Vector3(), position: new Vector3() };
  private following: string | null = null;
  private userDriving = false;
  private hasFramed = false;
  private portrait = false;
  /** Keep re-framing as teams arrive until the user takes the camera. */
  private autoFrame = true;
  private framedKey = '';

  constructor(private container: HTMLElement, private cb: WorldCallbacks) {
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // The building barely moves; refresh shadows a few times a second, not every frame.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Count draws across every post-processing pass, not just the last one.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    // Lights: soft sky fill plus one sun for shadows.
    this.scene.add(this.hemi);
    this.sun.position.set(14, 24, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(REC ? 8192 : 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun, this.sun.target);
    for (let i = 0; i < 6; i++) {
      const l = new PointLight('#ffd7a8', 0, 14, 1.6);
      l.position.set(0, -50, 0);
      this.nightLights.push(l);
      this.scene.add(l);
    }

    // Endless studio floor that fades into the sky.
    this.groundMat = new MeshStandardMaterial({ roughness: 0.95, map: floorTexture() });
    this.ground = new Mesh(new PlaneGeometry(600, 600), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.3;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground, this.courier.root, this.building.root);

    this.camera.position.set(18, 20, 24);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 110;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.32;
    // Map-like: drag to pan, right-drag to orbit, scroll to zoom.
    this.controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
    this.controls.addEventListener('start', () => {
      // The user grabbed the camera: hand control over immediately.
      this.userDriving = true;
      this.flight = null;
      this.flightVel.target.set(0, 0, 0);
      this.flightVel.position.set(0, 0, 0);
      this.following = null;
      this.autoFrame = false;
    });
    this.controls.addEventListener('end', () => (this.userDriving = false));

    const size = new Vector2();
    this.renderer.getDrawingBufferSize(size);
    // At 4K-and-up the supersampling already smooths edges; 8x MSAA there costs too much memory.
    const megapixels = (size.x * size.y) / 1e6;
    const samples = REC && megapixels < 9 ? Math.min(8, this.renderer.capabilities.maxSamples) : 4;
    const rt = new WebGLRenderTarget(size.x || 1, size.y || 1, { type: HalfFloatType, samples });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.2, 0.55, 1.02);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => (this.reduced = e.matches));
    this.setTheme('light');
    this.loop();
  }

  // ---------------------------------------------------------------- theme

  setTheme(theme: ThemeName) {
    this.theme = theme;
    const p = PALETTES[theme];
    this.scene.background = skyTexture(p.skyHorizon, p.sky);
    this.scene.fog = new Fog(p.sky, 80, 260);
    this.groundMat.color.set(p.floor);
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.bloom.strength = p.bloom;
    // Bloom only matters at night; skip the whole pass in daylight.
    this.bloom.enabled = theme === 'dark';
    applyThemeToMaterials(theme);
    setDeskLamps(p.lampIntensity);
    setNightGlow(theme === 'dark');
    this.building.setTheme(theme);
    for (const r of this.rooms.values()) r.setTheme(theme);
    this.refreshRooms();
    this.shadowDirty = true;
    this.placeNightLights();
  }

  // ---------------------------------------------------------------- sync

  /** Reconcile the scene with world state. Cheap enough to call on every event. */
  private screenBudget = 0;
  private frustum = new Frustum();
  private projView = new Matrix4();
  /** ?rec (scripted recordings): fixed resolution, no adaptive drops. */
  private lockResolution = new URLSearchParams(location.search).has('rec');
  private pixelRatio = this.lockResolution ? Math.min(devicePixelRatio, 4) : Math.min(devicePixelRatio, 1.75);
  private slowFrames = 0;
  private fastFrames = 0;
  private frameNo = 0;
  private shadowDirty = true;
  /** A fixed pool of night lights that follows the camera: constant shader cost, no recompiles. */
  private nightLights: PointLight[] = [];

  private isNear(o: Object3D) {
    const p = o.getWorldPosition(this.tmpV);
    return p.distanceToSquared(this.camera.position) < 26 * 26 && this.frustum.containsPoint(p);
  }
  private tmpV = new Vector3();

  /**
   * Fraction of the viewport (in NDC, 1 = edge) that framing may use. Recordings
   * for Reels shrink it so content stays clear of the platform's overlays.
   */
  safeArea = { x: 1, y: 1 };

  readonly perf = { frameMs: 0, fps: 0, syncMs: 0, worstSyncMs: 0, calls: 0, triangles: 0, agents: 0 };

  sync(state: WorldState) {
    const t0 = performance.now();
    this.syncInner(state);
    const ms = performance.now() - t0;
    this.perf.syncMs = ms;
    this.perf.worstSyncMs = Math.max(this.perf.worstSyncMs * 0.995, ms);
  }

  private syncInner(state: WorldState) {
    this.state = state;
    const instant = this.instantNext;
    this.instantNext = false;
    this.plan = computeLayout(state, this.book);
    this.building.update(this.plan);

    // Rooms
    for (const [id, room] of this.layout) {
      let r = this.rooms.get(id);
      if (!r) {
        r = new TeamRoom(room.team, this.theme);
        this.rooms.set(id, r);
        this.scene.add(r.root);
      }
      r.layout(room);
    }

    // Agents
    for (const agent of Object.values(state.agents)) {
      const room = this.layout.get(agent.team);
      const seat = room?.seats.get(agent.id);
      if (!room || !seat) continue;
      let s = this.agents.get(agent.id);
      if (s && s.team !== agent.team) {
        this.dropAgent(agent.id);
        s = undefined;
      }
      if (!s) {
        const character = new Character(agent);
        const desk = new Workstation(agent);
        const roomObj = this.rooms.get(agent.team)!;
        roomObj.floor.add(desk.root, character.root);
        desk.setSeat(seat, true);
        if (instant || this.reduced) character.setSeat(seat, true);
        else character.arrive(room.entry, seat);
        s = { character, desk, team: agent.team, leaving: false };
        this.agents.set(agent.id, s);
      } else {
        s.desk.setSeat(seat);
        s.character.setSeat(seat);
      }
      s.character.setStatus(agent.status);
      if (agent.id === 'engineer') s.desk.setReport(this.studioReport);
      if (agent.status === 'offline' && !s.leaving) this.depart(agent.id);
    }

    // Departures: anyone no longer in state walks out.
    for (const id of this.agents.keys()) if (!state.agents[id]) this.depart(id);

    this.refreshRooms();
    this.shadowDirty = true;

    this.fitShadows();
    if (!this.hasFramed && Object.keys(state.agents).length) {
      this.hasFramed = true;
      this.frameAll(true);
    } else if (this.autoFrame && !this.selected) {
      const b = this.footprint();
      const key = `${b.w.toFixed(1)}x${b.d.toFixed(1)}`;
      if (key !== this.framedKey) this.frameAll();
    }
  }

  /** Redraw door signs and whiteboards (cheap: each room skips when nothing changed). */
  private refreshRooms() {
    if (!this.state) return;
    const byTeam = new Map<string, Agent[]>();
    for (const a of Object.values(this.state.agents)) {
      if (!byTeam.has(a.team)) byTeam.set(a.team, []);
      byTeam.get(a.team)!.push(a);
    }
    for (const r of this.rooms.values()) {
      const team = this.state.teams[r.id];
      if (team) r.refresh(team, byTeam.get(r.id) || [], this.theme === 'dark');
    }
  }

  private depart(id: string) {
    const s = this.agents.get(id);
    if (!s || s.leaving) return;
    s.leaving = true;
    const room = this.layout.get(s.team);
    // Walk back out the way they came: through the office door, down the corridor, out the front.
    const exit: [number, number][] = room ? [...room.entry].reverse() : [[0, 6]];
    if (this.reduced) return this.dropAgent(id);
    s.character.leave(exit, () => this.dropAgent(id));
  }

  private dropAgent(id: string) {
    const s = this.agents.get(id);
    if (!s) return;
    s.character.dispose();
    s.desk.dispose();
    this.agents.delete(id);
    if (this.selected === id) this.cb.onPick(null, null);
    // Remove empty rooms once everyone has walked out.
    const team = s.team;
    if (![...this.agents.values()].some((a) => a.team === team) && !this.layout.has(team)) {
      this.rooms.get(team)?.dispose();
      this.rooms.delete(team);
    }
  }

  reset() {
    for (const id of [...this.agents.keys()]) this.dropAgent(id);
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
    this.courier.clear();
    this.book = new SeatBook();
    this.instantNext = true;
    this.hasFramed = false;
    this.autoFrame = true;
  }

  handleEffect(effect: Effect) {
    if (effect.kind === 'reset') return this.reset();
    if (effect.kind !== 'message') return;
    const from = this.agents.get(effect.from);
    const to = this.agents.get(effect.to);
    if (!from || !to) return;
    const a = from.character.headWorld();
    const b = to.character.headWorld();
    from.character.lookAtWorld(b, 2.6, true);
    this.cb.onMessage(effect.from, effect.to, effect.text);
    const team = this.state?.teams[from.team];
    const color = team ? teamAccent(team.hue).getStyle() : '#ff5f2e';
    this.courier.send(a.add(new Vector3(0, 0.35, 0)), b.add(new Vector3(0, 0.35, 0)), color, this.reduced, () => {
      to.character.lookAtWorld(from.character.headWorld(), 1.8);
      this.courier.ripple(to.character.root.getWorldPosition(new Vector3()), color);
    });
  }

  // ---------------------------------------------------------------- ENG-160 dry-run studio

  setStudioReport(status: 'ready' | 'rejected' | null) {
    this.studioReport = status;
    this.agents.get('engineer')?.desk.setReport(status);
  }

  walkEngineerToCoo() {
    const engineer = this.agents.get('engineer');
    const room = engineer ? this.layout.get(engineer.team) : null;
    const from = room?.seats.get('engineer');
    const to = room?.seats.get('coo');
    if (!room || !from || !to) return;
    const aisle = room.d / 2 - 1.15;
    engineer!.character.visit([
      [from.x, aisle],
      [to.x, aisle],
      [to.x, to.z + 0.9],
      [to.x, aisle],
      [from.x, aisle],
    ]);
  }

  focusStudio() {
    const room = this.rooms.get('msos');
    const coo = this.agents.get('coo');
    const engineer = this.agents.get('engineer');
    if (!room || !coo || !engineer) return;
    this.autoFrame = false;
    const { w, d } = room.size;
    const target = coo.character.root.getWorldPosition(new Vector3())
      .add(engineer.character.root.getWorldPosition(new Vector3())).multiplyScalar(0.5);
    target.y = 0.6;
    const dir = new Vector3(0.3, 1.1, 1).normalize();
    // Centre the seats rather than the asymmetric room so both HTML name tags
    // stay inside a phone viewport. Ignore fitDistance's own target adjustment.
    const dist = this.fitDistance([{ x: room.center.x, z: room.center.z, w, d }], target.clone(), dir, 0.82);
    this.flyTo(target, target.clone().add(dir.multiplyScalar(dist)), null);
  }

  deskAnchor(id: string): Anchor | null {
    const seated = this.agents.get(id);
    if (!seated) return null;
    const v = seated.desk.root.getWorldPosition(new Vector3());
    v.y += 1.25;
    const depth = v.distanceTo(this.camera.position);
    v.project(this.camera);
    return {
      id,
      x: (v.x * 0.5 + 0.5) * this.container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.container.clientHeight,
      depth,
      visible: v.z < 1 && seated.character.root.visible && !seated.leaving,
    };
  }

  // ---------------------------------------------------------------- selection & camera

  setSelected(id: string | null) {
    if (this.selected) this.agents.get(this.selected)?.character.setSelected(false);
    this.selected = id;
    if (id) {
      this.agents.get(id)?.character.setSelected(true);
      this.focusAgent(id);
    }
  }

  focusAgent(id: string) {
    const s = this.agents.get(id);
    if (!s) return;
    // Someone chose what to look at: stop re-framing on their behalf.
    this.autoFrame = false;
    const p = s.character.root.getWorldPosition(new Vector3());
    const target = p.clone().add(new Vector3(0, 0.9, 0));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // Keep the viewing angle the user chose, just come closer.
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    this.flyTo(target, target.clone().add(dir.multiplyScalar(9)), id);
  }

  focusTeam(id: string) {
    const r = this.rooms.get(id);
    if (!r) return;
    this.autoFrame = false;
    const { w, d } = r.size;
    const c = r.center;
    const target = new Vector3(c.x, 0.6, c.z);
    const dir = new Vector3(0.55, 0.85, 1).normalize();
    const dist = this.fitDistance([{ x: c.x, z: c.z, w, d }], target, dir, 0.92);
    this.flyTo(target, target.clone().add(dir.multiplyScalar(dist)), null);
  }

  /**
   * Fit a set of floor rectangles (floor to head height) into the viewport.
   * Binary-searches the distance along `dir`, then nudges the target in screen
   * space so the content is centred, and repeats. Mutates `target`.
   */
  private fitDistance(rects: { x: number; z: number; w: number; d: number }[], target: Vector3, dir: Vector3, margin: number) {
    const probe = this.camera.clone();
    const corners: Vector3[] = [];
    for (const r of rects)
      for (const x of [r.x - r.w / 2, r.x + r.w / 2])
        for (const z of [r.z - r.d / 2, r.z + r.d / 2]) for (const y of [0, 2.2]) corners.push(new Vector3(x, y, z));
    const v = new Vector3();
    const extent = (dist: number) => {
      probe.position.copy(target).addScaledVector(dir, dist);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of corners) {
        v.copy(p).project(probe);
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
      return { minX, maxX, minY, maxY };
    };
    // Vertical budget is smaller: the top bar and team dock take space.
    const fits = (dist: number) => {
      const e = extent(dist);
      const sx = margin * this.safeArea.x;
      const sy = this.safeArea.y;
      return e.minX >= -sx && e.maxX <= sx && e.minY >= Math.max(-margin + 0.16, -sy) && e.maxY <= Math.min(margin - 0.14, sy);
    };
    let dist = 30;
    for (let pass = 0; pass < 3; pass++) {
      let lo = 3;
      let hi = 200;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      dist = hi;
      const e = extent(dist);
      const cx = (e.minX + e.maxX) / 2;
      const cy = (e.minY + e.maxY) / 2 - 0.01;
      const halfH = dist * Math.tan(((probe.fov / 2) * Math.PI) / 180);
      const halfW = halfH * probe.aspect;
      const right = new Vector3().setFromMatrixColumn(probe.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(probe.matrixWorld, 1);
      target.addScaledVector(right, cx * halfW).addScaledVector(up, cy * halfH);
      target.y = Math.max(0, target.y);
    }
    return dist;
  }

  frameAll(instant = false) {
    const b = this.footprint();
    this.framedKey = `${b.w.toFixed(1)}x${b.d.toFixed(1)}`;
    this.autoFrame = true;
    const target = new Vector3(b.cx, 0.4, b.cz);
    // Portrait: look more head-on so the stacked rooms run up the screen.
    const dir = (this.portrait ? new Vector3(0.15, 1.5, 1) : new Vector3(0.55, 0.95, 1)).normalize();
    const dist = this.fitDistance([{ x: b.cx, z: b.cz, w: b.w, d: b.d }], target, dir, 0.97);
    const position = target.clone().add(dir.multiplyScalar(Math.max(dist, 12)));
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.flight = null;
    } else this.flyTo(target, position, null);
  }

  private flyTo(target: Vector3, position: Vector3, follow: string | null) {
    if (this.reduced) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.following = follow;
      return;
    }
    this.flight = { target, position, follow };
  }

  private updateCamera(dt: number) {
    if (this.flight) {
      const { target, position } = this.flight;
      const t = this.controls.target;
      const c = this.camera.position;
      // Critically damped springs: start from the current velocity (zero when at
      // rest), accelerate smoothly, settle without overshoot. Interruptible.
      springStep(t, this.flightVel.target, target, FLIGHT_RESPONSE, dt);
      springStep(c, this.flightVel.position, position, FLIGHT_RESPONSE, dt);
      if (t.distanceTo(target) < 0.01 && c.distanceTo(position) < 0.02 && this.flightVel.position.length() < 0.05) {
        this.following = this.flight.follow;
        this.flight = null;
        this.flightVel.target.set(0, 0, 0);
        this.flightVel.position.set(0, 0, 0);
      }
    } else if (this.following && !this.userDriving) {
      // Keep a selected agent centred as it moves (walking in, standing up).
      const s = this.agents.get(this.following);
      if (s) {
        const p = s.character.root.getWorldPosition(new Vector3()).add(new Vector3(0, 0.9, 0));
        const delta = p.sub(this.controls.target).multiplyScalar(1 - Math.exp(-5 * dt));
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    this.controls.update();
  }

  private fitShadows() {
    const b = this.footprint();
    const half = Math.max(b.w, b.d) / 2 + 9;
    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = 120;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(b.cx, 0, b.cz);
    this.sun.position.set(b.cx + 16, 28, b.cz + 12);
  }

  // ---------------------------------------------------------------- pointer

  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerDirty = true;
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
    el.addEventListener('pointerdown', (e) => this.downAt.set(e.clientX, e.clientY));
    el.addEventListener('pointerup', (e) => {
      // A click, not the end of a drag.
      if (this.downAt.distanceTo(new Vector2(e.clientX, e.clientY)) > 6) return;
      const hit = this.pick(e);
      this.cb.onPick(hit.agent, hit.team);
    });
    el.addEventListener('dblclick', (e) => {
      const hit = this.pick(e);
      if (!hit.agent && !hit.team) this.frameAll();
    });
  }

  private pick(e: { clientX: number; clientY: number }) {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    const p = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    return this.raycast(p);
  }

  private raycast(p: Vector2): { agent: string | null; team: string | null } {
    this.raycaster.setFromCamera(p, this.camera);
    // Only hit boxes live on the pick layer: one box per agent, one slab per office.
    this.raycaster.layers.set(PICK_LAYER);
    const roots = [...this.rooms.values()].map((r) => r.root);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      const agent = findAgentId(h.object);
      if (agent) return { agent, team: this.agents.get(agent)?.team ?? null };
      const team = findTeamId(h.object);
      if (team) return { agent: null, team };
    }
    return { agent: null, team: null };
  }

  private setHover(id: string | null) {
    if (id === this.hovered) return;
    if (this.hovered) this.agents.get(this.hovered)?.character.setHovered(false);
    this.hovered = id;
    if (id) this.agents.get(id)?.character.setHovered(true);
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.cb.onHover(id);
  }

  // ---------------------------------------------------------------- frame

  /** Screen positions above each head, for the HTML name tags. */
  anchors(): Anchor[] {
    const out: Anchor[] = [];
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const v = new Vector3();
    for (const [id, s] of this.agents) {
      s.character.headWorld(v);
      v.y += 0.62;
      const depth = v.distanceTo(this.camera.position);
      v.project(this.camera);
      out.push({
        id,
        x: (v.x * 0.5 + 0.5) * w,
        y: (-v.y * 0.5 + 0.5) * h,
        depth,
        visible: v.z < 1 && s.character.root.visible && !s.leaving,
      });
    }
    return out;
  }

  agentIds() {
    return [...this.agents.keys()];
  }

  onFrame?: () => void;

  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.elapsed += dt;
    const dark = this.theme === 'dark';

    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.setHover(this.raycast(this.pointer).agent);
    }

    this.screenBudget = 10;
    this.frustum.setFromProjectionMatrix(this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    for (const [id, s] of this.agents) {
      s.character.update(dt, this.elapsed, this.reduced);
      const agent = this.state?.agents[id];
      if (agent) {
        // Monitors are canvas textures: only redraw the ones you can actually read.
        const near = this.screenBudget > 0 && this.isNear(s.character.root);
        if (near) this.screenBudget--;
        s.desk.update(dt, this.elapsed, agent, dark, s.character.isSeated(), s.character.root.rotation.y, near);
      }
    }
    this.building.tick(dt, this.camera);
    this.courier.update(dt);
    this.updateCamera(dt);
    this.frameNo++;
    // Recordings refresh shadows every frame so moving shadows never step.
    if (this.shadowDirty || this.lockResolution || this.frameNo % 4 === 0) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    if (!this.lockResolution) this.adaptResolution(dt);
    if (this.frameNo % 30 === 0) this.placeNightLights();
    const r0 = performance.now();
    this.renderer.info.reset();
    this.composer.render();
    this.onFrame?.();
    const p = this.perf;
    p.frameMs = p.frameMs * 0.9 + (performance.now() - r0) * 0.1;
    p.fps = p.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    p.calls = this.renderer.info.render.calls;
    p.triangles = this.renderer.info.render.triangles;
    p.agents = this.agents.size;
  };

  private placeNightLights() {
    const night = this.theme === 'dark';
    const spots = night
      ? [...[...this.rooms.values()].map((r) => r.center.clone().setY(2.9)), ...this.building.lightSpots()]
      : [];
    const t = this.controls.target;
    spots.sort((a, b) => a.distanceToSquared(t) - b.distanceToSquared(t));
    this.nightLights.forEach((l, i) => {
      const spot = spots[i];
      l.intensity = spot ? 10 : 0;
      if (spot) l.position.copy(spot);
    });
  }

  /** Dynamic resolution: render fewer pixels when frames run long, more when there is headroom. */
  private adaptResolution(dt: number) {
    if (dt > 1 / 40) this.slowFrames++;
    else if (dt < 1 / 55) this.fastFrames++;
    const cap = Math.min(devicePixelRatio, 1.75);
    let next = this.pixelRatio;
    if (this.slowFrames > 40) next = Math.max(0.75, this.pixelRatio - 0.25);
    else if (this.fastFrames > 300 && this.pixelRatio < cap) next = Math.min(cap, this.pixelRatio + 0.25);
    if (this.slowFrames > 40 || this.fastFrames > 300) {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const portrait = w / h < 0.8;
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      if (this.state && this.autoFrame) this.frameAll();
    }
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }
}

/** Seconds a camera flight takes to (almost) arrive. */
const FLIGHT_RESPONSE = 1.1;

/** One critically damped spring step per axis (Apple's response/damping model, damping = 1). */
function springStep(x: Vector3, v: Vector3, goal: Vector3, response: number, dt: number) {
  const k = Math.pow((2 * Math.PI) / response, 2);
  const c = (4 * Math.PI) / response;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = Math.min(dt, 0.1) / steps;
  for (let i = 0; i < steps; i++) {
    v.x += (-k * (x.x - goal.x) - c * v.x) * h;
    v.y += (-k * (x.y - goal.y) - c * v.y) * h;
    v.z += (-k * (x.z - goal.z) - c * v.z) * h;
    x.x += v.x * h;
    x.y += v.y * h;
    x.z += v.z * h;
  }
}

function skyTexture(horizon: string, top: string) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.75, horizon);
  g.addColorStop(1, horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Very low-contrast concrete tiles so the floor has scale without visual noise. */
function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const v = 236 + Math.floor(Math.random() * 16);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 256, 256);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(150, 150);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

