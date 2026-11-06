import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, RingGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector3, type Material } from 'three';
import { Kit } from './kit';
import type { Agent, Status } from '../../shared/protocol';
import { clay, G } from './materials';
import { looksFor, shirtFor, STATUS_COLORS } from './palette';
import type { Seat } from './layout';
import { makeCanvas } from './text';
import { Spring, damp, dampAngle } from './motion';

const SEAT_H = 0.5;
const STAND_H = 0.78;
const WALK_SPEED = 1.7;

type Mode = 'walking' | 'seated' | 'leaving' | 'gone';

// ---------------------------------------------------------------- badges
// Shared canvas textures for the floating attention badges.
const badgeCache = new Map<string, SpriteMaterial>();
function badge(kind: 'waiting' | 'error' | 'done' | 'thinking') {
  let m = badgeCache.get(kind);
  if (m) return m;
  const { ctx, texture } = makeCanvas(128, 128);
  const color = STATUS_COLORS[kind];
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = kind === 'thinking' ? '#ffffff' : color;
  ctx.beginPath();
  ctx.arc(64, 60, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'done') {
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(42, 62);
    ctx.lineTo(58, 78);
    ctx.lineTo(88, 46);
    ctx.stroke();
  } else if (kind === 'thinking') {
    ctx.fillStyle = color;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(40 + i * 24, 60, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillRect(58, 30, 12, 38);
    ctx.beginPath();
    ctx.arc(64, 84, 7.5, 0, Math.PI * 2);
    ctx.fill();
  }
  m = new SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
  badgeCache.set(kind, m);
  return m;
}

const ringGeo = new RingGeometry(0.42, 0.56, 32);
const selectGeo = new TorusGeometry(0.66, 0.035, 6, 48);
const glassesGeo = new TorusGeometry(0.055, 0.012, 5, 14);
const headbandGeo = new TorusGeometry(0.27, 0.018, 6, 20, Math.PI);
const hitGeo = new BoxGeometry(0.7, 1.7, 0.7);
const hitMat = new MeshBasicMaterial({ visible: false });
/** Raycasts for picking only look at this layer. */
export const PICK_LAYER = 1;


/**
 * One agent. A small clay figure that walks in from the door, sits at its desk,
 * types, thinks, waves when it needs you, celebrates when done, and walks out.
 */
export class Character {
  readonly root = new Group();
  readonly id: string;
  private body = new Group();
  private torso = new Group();
  private head = new Group();
  private armL = new Group();
  private armR = new Group();
  private legL = new Group();
  private legR = new Group();
  private shinL = new Group();
  private shinR = new Group();
  private eyes = new Group();
  private hitbox: Mesh;
  private badge = new Sprite(badge('thinking'));
  private badgeKind: string | null = null;
  private badgeScale = new Spring(0, { response: 0.35, damping: 0.62 });
  private statusRing: Mesh;
  private statusMat: MeshBasicMaterial;
  private selectRing: Mesh;
  private selectScale = new Spring(0, { response: 0.3, damping: 0.7 });
  private fade = new Spring(1, { response: 0.4, damping: 1 });
  private hop = new Spring(0, { response: 0.28, damping: 0.45 });
  private shake = 0;
  private hoverLift = new Spring(0, { response: 0.25, damping: 0.8 });

  mode: Mode = 'seated';
  private path: Vector3[] = [];
  private speed = WALK_SPEED;
  private seat: Seat | null = null;
  private status: Status = 'idle';
  private sitAmount = 1; // 1 seated, 0 standing
  private walkPhase = 0;
  private blinkAt = 0;
  private lookTarget: Vector3 | null = null;
  private lookUntil = 0;
  private gestureUntil = 0;
  private phase: number;
  private onGone?: () => void;

  constructor(agent: Agent) {
    this.id = agent.id;
    const look = looksFor(agent.id);
    this.phase = (look.hairStyle + 1) * 1.7;
    const shirt = clay(shirtFor(agent.role));
    const skin = clay(look.skin, { roughness: 0.7 });
    const hair = clay(look.hair, { roughness: 0.9 });
    const pants = clay(look.pants);
    const dark = clay('#1d1f24', { roughness: 0.4 });

    // Every moving part is batched into a single mesh (colours baked into
    // vertices), so a character costs ~9 draws instead of ~35.
    const bake = (target: Group, describe: (k: Kit) => void) => {
      const k = new Kit();
      describe(k);
      target.add(k.build());
    };

    // Torso: shirt capsule with a little collar of skin.
    this.torso.position.y = 0.3;
    bake(this.torso, (k) => {
      k.add(G.capsule(0.2, 0.2), shirt, 0, 0, 0);
      k.add(G.cyl(0.07, 0.08, 0.06, 12), skin, 0, 0.22, 0);
    });
    this.body.add(this.torso);

    // Head: face, cheeks, hair, accessories. Eyes are their own mesh so they can blink.
    this.head.position.y = 0.52;
    bake(this.head, (k) => {
      k.add(G.sphere(0.25), skin);
      for (const side of [-1, 1]) k.add(G.sphere(0.035, 8, 6), clay('#f19a8a', { roughness: 0.9 }), side * 0.14, -0.06, -0.2, { sx: 1, sy: 0.6, sz: 0.4, cast: false });
      this.addHair(k, look.hairStyle, hair, shirt);
      if (look.glasses) this.addGlasses(k, dark);
      if (agent.role.toLowerCase() === 'lead') this.addHeadset(k, dark);
    });
    this.eyes.position.set(0, 0.02, -0.228);
    bake(this.eyes, (k) => {
      for (const side of [-1, 1]) k.add(G.sphere(0.034, 8, 6), dark, side * 0.085, 0, 0, { cast: false });
    });
    this.head.add(this.eyes);
    this.torso.add(this.head);

    // Arms hang from shoulder pivots.
    for (const [arm, side] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(side * 0.255, 0.14, 0);
      bake(arm, (k) => {
        k.add(G.capsule(0.062, 0.24), shirt, 0, -0.16, 0);
        k.add(G.sphere(0.07, 10, 8), skin, 0, -0.33, 0);
      });
      this.torso.add(arm);
    }
    // Legs: thigh pivot at the hip, shin pivot at the knee.
    for (const [leg, shin, side] of [[this.legL, this.shinL, -1], [this.legR, this.shinR, 1]] as const) {
      leg.position.set(side * 0.1, 0.08, 0);
      bake(leg, (k) => k.add(G.capsule(0.078, 0.2), pants, 0, -0.14, 0));
      shin.position.y = -0.3;
      bake(shin, (k) => {
        k.add(G.capsule(0.07, 0.18), pants, 0, -0.12, 0);
        k.add(G.rbox(0.13, 0.08, 0.2, 0.035), dark, 0, -0.26, -0.04);
      });
      leg.add(shin);
      this.body.add(leg);
    }

    this.root.add(this.body);

    // Status ring on the floor (semantic: colour = status).
    this.statusMat = new MeshBasicMaterial({ color: STATUS_COLORS.idle, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
    this.statusRing = new Mesh(ringGeo, this.statusMat);
    this.statusRing.rotation.x = -Math.PI / 2;
    this.statusRing.position.y = 0.075;
    this.root.add(this.statusRing);

    this.selectRing = new Mesh(selectGeo, new MeshBasicMaterial({ color: '#ff5f2e', toneMapped: false }));
    this.selectRing.rotation.x = -Math.PI / 2;
    this.selectRing.position.y = 0.08;
    this.selectRing.scale.setScalar(0.001);
    this.selectRing.visible = false;
    this.root.add(this.selectRing);

    this.badge.position.y = 1.85;
    this.badge.scale.setScalar(0.001);
    this.badge.visible = false;
    this.badge.renderOrder = 10;
    this.root.add(this.badge);

    // An invisible hit box for picking, so hover tests one box, not every triangle.
    this.hitbox = new Mesh(hitGeo, hitMat);
    this.hitbox.position.y = 0.85;
    this.hitbox.layers.set(PICK_LAYER);
    this.root.add(this.hitbox);

    this.root.traverse((o) => {
      o.userData.agentId = agent.id;
    });
  }

  private addHair(k: Kit, style: number, hair: Material, shirt: Material) {
    k.add(G.hemi(0.268), style === 4 ? shirt : hair, 0, 0.02, 0.02, { rx: -0.32 });
    if (style === 1) k.add(G.sphere(0.1), hair, 0, 0.22, 0.14);
    if (style === 2) k.add(G.rbox(0.46, 0.36, 0.16, 0.07), hair, 0, -0.1, 0.13);
    if (style === 3) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        k.add(G.sphere(0.075, 8, 6), hair, Math.cos(a) * 0.12, 0.24, Math.sin(a) * 0.12 + 0.03);
      }
    }
    if (style === 4) {
      k.add(G.cyl(0.272, 0.272, 0.06, 18), hair, 0, 0.06, 0.02, { rx: -0.32 });
      k.add(G.sphere(0.06, 8, 6), hair, 0, 0.29, 0.08);
    }
  }

  private addGlasses(k: Kit, dark: Material) {
    for (const side of [-1, 1]) k.add(glassesGeo, dark, side * 0.085, 0.02, -0.235, { cast: false });
    k.add(G.box(0.06, 0.012, 0.012), dark, 0, 0.03, -0.24, { cast: false });
  }

  private addHeadset(k: Kit, dark: Material) {
    k.add(headbandGeo, dark, 0, 0.02, 0);
    for (const side of [-1, 1]) k.add(G.cyl(0.07, 0.07, 0.06, 12), dark, side * 0.26, 0, 0, { rz: Math.PI / 2 });
    k.add(G.capsule(0.012, 0.16), dark, -0.2, -0.12, -0.12, { rx: 0.6, rz: 0.9 });
    k.add(G.sphere(0.025, 8, 6), clay('#ff5f2e'), -0.13, -0.17, -0.2);
  }

  // ---------------------------------------------------------------- commands

  setSeat(seat: Seat, instant = false) {
    this.seat = seat;
    if (instant) {
      this.mode = 'seated';
      this.sitAmount = 1;
      this.root.position.set(seat.x, 0, seat.z);
      this.root.rotation.y = seat.yaw;
    }
  }

  /** Spawn at the building entrance and walk the whole way to the seat. */
  arrive(entry: [number, number][], seat: Seat) {
    this.seat = seat;
    const [start, ...rest] = entry;
    this.root.position.set(start[0], 0, start[1]);
    this.mode = 'walking';
    this.sitAmount = 0;
    this.fade.value = 0;
    this.fade.target = 1;
    this.path = [...rest, ...seat.path].map(([x, z]) => new Vector3(x, 0, z));
    this.speed = this.paceFor(this.path);
  }

  /** Dry-run studio visit: walk to another desk and then return to this seat. */
  visit(waypoints: [number, number][]) {
    if (!this.seat || this.mode === 'leaving' || this.mode === 'gone') return;
    this.mode = 'walking';
    this.sitAmount = 0;
    this.path = [...waypoints, [this.seat.x, this.seat.z]].map(([x, z]) => new Vector3(x, 0, z));
    this.speed = this.paceFor(this.path);
  }

  /** Long trips are walked briskly so arrivals never take more than ~9 s. */
  private paceFor(path: Vector3[]) {
    let len = 0;
    let prev = this.root.position;
    for (const p of path) {
      len += prev.distanceTo(p);
      prev = p;
    }
    return Math.min(4.2, Math.max(WALK_SPEED, len / 9));
  }

  /** Stand up and walk out along `exit` (office door, corridor, front door). */
  leave(exit: [number, number][], onGone: () => void) {
    if (this.mode === 'leaving' || this.mode === 'gone') return;
    this.mode = 'leaving';
    this.onGone = onGone;
    const back = this.seat ? [...this.seat.path].reverse().slice(1) : [];
    this.path = [...back, ...exit].map(([x, z]) => new Vector3(x, 0, z));
    this.speed = this.paceFor(this.path);
  }

  /** Turn to face a world-space point for a moment (talking / listening). */
  lookAtWorld(point: Vector3, seconds = 2.4, gesture = false) {
    this.lookTarget = point.clone();
    this.lookUntil = performance.now() / 1000 + seconds;
    if (gesture) this.gestureUntil = this.lookUntil;
  }

  setStatus(status: Status) {
    if (status === this.status) return;
    const prev = this.status;
    this.status = status;
    this.statusMat.color.set(STATUS_COLORS[status]);
    if (status === 'done' && prev !== 'done') this.hop.velocity = 5.5;
    if (status === 'error' && prev !== 'error') this.shake = 1;
    const kind = status === 'waiting' || status === 'error' || status === 'done' || status === 'thinking' ? status : null;
    if (kind !== this.badgeKind) {
      this.badgeKind = kind;
      if (kind) {
        this.badge.material = badge(kind);
        this.badgeScale.value = 0;
        this.badgeScale.target = kind === 'thinking' ? 0.34 : 0.44;
      } else this.badgeScale.target = 0;
    }
  }

  setSelected(on: boolean) {
    this.selectScale.target = on ? 1 : 0;
  }

  setHovered(on: boolean) {
    this.hoverLift.target = on ? 1 : 0;
  }

  headWorld(out = new Vector3()) {
    return this.head.getWorldPosition(out);
  }

  // ---------------------------------------------------------------- frame

  update(dt: number, t: number, reduced: boolean) {
    if (this.mode === 'gone') return;
    const now = performance.now() / 1000;

    // ---- locomotion
    let moving = false;
    if ((this.mode === 'walking' || this.mode === 'leaving') && this.sitAmount < 0.05) {
      const target = this.path[0];
      if (target) {
        const pos = this.root.position;
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const dist = Math.hypot(dx, dz);
        const step = this.speed * dt;
        if (dist <= step || dist < 0.01) {
          pos.x = target.x;
          pos.z = target.z;
          this.path.shift();
        } else {
          pos.x += (dx / dist) * step;
          pos.z += (dz / dist) * step;
          moving = true;
          // Face the direction of travel. Forward is -Z.
          this.root.rotation.y = dampAngle(this.root.rotation.y, Math.atan2(-dx, -dz), 12, dt);
        }
      }
      if (!this.path.length) {
        if (this.mode === 'walking') this.mode = 'seated';
        else {
          this.fade.target = 0;
          if (this.fade.value < 0.03) {
            this.mode = 'gone';
            this.onGone?.();
            return;
          }
        }
      }
    }

    // Standing up / sitting down
    const wantSit = this.mode === 'seated' ? 1 : 0;
    if (this.mode === 'seated' && this.seat) {
      // Slide onto the chair and turn to the desk.
      const pos = this.root.position;
      pos.x = damp(pos.x, this.seat.x, 10, dt);
      pos.z = damp(pos.z, this.seat.z, 10, dt);
    }
    this.sitAmount = damp(this.sitAmount, wantSit, 7, dt);

    // ---- facing
    let yawTarget: number | null = null;
    if (this.mode === 'seated' && this.seat) yawTarget = this.seat.yaw;
    if (this.lookTarget && now < this.lookUntil && this.mode === 'seated') {
      const p = this.root.parent ? this.root.parent.worldToLocal(this.lookTarget.clone()) : this.lookTarget;
      yawTarget = Math.atan2(-(p.x - this.root.position.x), -(p.z - this.root.position.z));
    }
    if (yawTarget !== null) this.root.rotation.y = dampAngle(this.root.rotation.y, yawTarget, 6, dt);

    // ---- posture
    const s = this.sitAmount;
    const base = STAND_H + (SEAT_H - STAND_H) * s;
    this.hop.update(dt);
    const hop = Math.max(0, this.hop.value) * 0.25;
    this.body.position.y = base + hop;

    const st = this.status;
    const working = st === 'working' && this.mode === 'seated';
    const thinking = st === 'thinking' && this.mode === 'seated';
    const waiting = st === 'waiting';
    const idle = (st === 'idle' || st === 'done' || st === 'offline') && this.mode === 'seated';
    const talking = now < this.gestureUntil;
    const k = reduced ? 0.25 : 1;

    // Legs: bent while seated, swinging while walking.
    this.walkPhase += moving ? dt * (6 + this.speed * 2.2) : 0;
    const swing = moving ? Math.sin(this.walkPhase) * 0.65 : 0;
    this.legL.rotation.x = damp(this.legL.rotation.x, s * (Math.PI / 2) + swing, 14, dt);
    this.legR.rotation.x = damp(this.legR.rotation.x, s * (Math.PI / 2) - swing, 14, dt);
    this.shinL.rotation.x = damp(this.shinL.rotation.x, -s * (Math.PI / 2) - (moving ? Math.max(0, -Math.sin(this.walkPhase)) * 0.7 : 0), 14, dt);
    this.shinR.rotation.x = damp(this.shinR.rotation.x, -s * (Math.PI / 2) - (moving ? Math.max(0, Math.sin(this.walkPhase)) * 0.7 : 0), 14, dt);
    if (moving) this.body.position.y += Math.abs(Math.sin(this.walkPhase)) * 0.04;

    // Arms
    let lx = 0, rx = 0, lz = 0, rz = 0;
    if (moving) {
      lx = -swing * 0.8;
      rx = swing * 0.8;
    } else if (working) {
      lx = 1.25 + Math.sin(t * 22 + this.phase) * 0.12 * k;
      rx = 1.25 + Math.sin(t * 22 + this.phase + 2.1) * 0.12 * k;
      lz = 0.25;
      rz = -0.25;
    } else if (thinking) {
      lx = 0.9;
      lz = 0.25;
      rx = 2.35;
      rz = -0.62;
    } else if (waiting) {
      rz = 2.7 + Math.sin(t * 9) * 0.28 * k;
      rx = 0.1;
      lx = 0.4;
    } else if (talking) {
      rx = 1.1 + Math.sin(t * 6) * 0.35 * k;
      rz = -0.2;
      lx = 0.5;
    } else if (idle) {
      lx = 0.45;
      rx = 0.45;
      lz = 0.12;
      rz = -0.12;
    }
    this.armL.rotation.x = damp(this.armL.rotation.x, lx, 12, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, rx, 12, dt);
    this.armL.rotation.z = damp(this.armL.rotation.z, lz, 12, dt);
    this.armR.rotation.z = damp(this.armR.rotation.z, rz, 12, dt);

    // Torso lean: forward when typing, back when idle.
    const breathe = Math.sin(t * 1.6 + this.phase) * 0.012 * k;
    const lean = working ? 0.16 : idle ? -0.14 : thinking ? 0.04 : 0;
    this.torso.rotation.x = damp(this.torso.rotation.x, -lean, 6, dt);
    this.torso.scale.y = 1 + breathe;

    // Head: nod while typing, tilt while thinking, shake on error.
    let hx = 0, hz = 0, hy = 0;
    if (working) hx = -0.1 + Math.sin(t * 3.1 + this.phase) * 0.03 * k;
    if (thinking) {
      hz = 0.22;
      hx = 0.18;
      hy = Math.sin(t * 0.8 + this.phase) * 0.25 * k;
    }
    if (idle) hy = Math.sin(t * 0.35 + this.phase) * 0.35 * k;
    if (this.shake > 0) {
      hy += Math.sin(this.shake * 30) * 0.35 * this.shake;
      this.shake = Math.max(0, this.shake - dt * 1.4);
    }
    this.head.rotation.x = damp(this.head.rotation.x, hx, 8, dt);
    this.head.rotation.z = damp(this.head.rotation.z, hz, 8, dt);
    this.head.rotation.y = damp(this.head.rotation.y, hy, 8, dt);

    // Blink
    if (t > this.blinkAt) this.blinkAt = t + 2 + ((this.phase * 997) % 3) + Math.random() * 2;
    const blinking = this.blinkAt - t < 0.12;
    this.eyes.scale.y = blinking ? 0.15 : 1;

    // Badge bobs above the head.
    this.badgeScale.update(dt);
    const bs = Math.max(0.001, this.badgeScale.value);
    this.badge.scale.setScalar(bs);
    this.badge.visible = bs > 0.01;
    this.badge.position.y = 2.02 + (1 - s) * 0.14 + hop + Math.sin(t * 3 + this.phase) * 0.04 * k;

    // Rings
    this.selectScale.update(dt);
    const sel = Math.max(0.001, this.selectScale.value);
    this.selectRing.visible = sel > 0.01;
    this.selectRing.scale.setScalar(sel * (1 + Math.sin(t * 3) * 0.03 * k));
    this.statusRing.visible = this.mode !== 'leaving';
    this.statusMat.opacity = (0.35 + (st === 'working' || st === 'waiting' ? Math.sin(t * 4) * 0.15 * k + 0.15 : 0)) * this.fade.value;

    // Hover: a small lift so the cursor clearly lands on someone.
    this.hoverLift.update(dt);
    this.body.position.y += this.hoverLift.value * 0.05;

    // Fade in / out on arrival and departure.
    this.fade.update(dt);
    const f = Math.min(1, Math.max(0, this.fade.value));
    this.root.scale.setScalar(0.6 + 0.4 * f);
    this.root.visible = f > 0.02;
  }

  isSeated() {
    return this.mode === 'seated' && this.sitAmount > 0.6;
  }

  dispose() {
    this.statusMat.dispose();
    (this.selectRing.material as Material).dispose();
    this.root.removeFromParent();
  }
}

export function findAgentId(o: Object3D | null): string | undefined {
  while (o) {
    if (o.userData.agentId) return o.userData.agentId as string;
    o = o.parent;
  }
  return undefined;
}
