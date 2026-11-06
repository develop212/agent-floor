import { AdditiveBlending, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry } from 'three';
import type { Agent } from '../../shared/protocol';
import { clay, G } from './materials';
import { Kit } from './kit';
import { NOTE_COLORS, plantSmall, rand, reseed } from './props';
import { posterMaterial } from './textures';
import { hash } from './palette';
import { Screen, sideScreenMaterial } from './Screen';
import { makeCanvas } from './text';
import type { Seat } from './layout';
import { damp, dampAngle } from './motion';

const DESK_W = 1.48;
const DESK_D = 0.7;
const DESK_H = 0.74;
const DESK_OFFSET = 0.8; // desk centre distance in front of the seat

const screenGeo = new PlaneGeometry(0.6, 0.375);
const lampBulbMat = new MeshBasicMaterial({ color: '#ffe2b0', toneMapped: false });

// A warm pool of light on the desk, faked with an additive radial gradient so
// the night shift glows without a real light per desk.
const poolGeo = new PlaneGeometry(1.5, 1.1);
const poolMat = (() => {
  const { ctx, texture } = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,200,130,0.9)');
  g.addColorStop(1, 'rgba(255,200,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new MeshBasicMaterial({ map: texture, transparent: true, blending: AdditiveBlending, depthWrite: false, opacity: 0 });
})();

/** Theme hook: lamps on for the night shift, off in daylight. */
const screenMats = new Set<MeshBasicMaterial>();
let screenBoost = 1;

/**
 * Theme hook. Bloom only catches values above 1.0, so at night the screens and
 * bulbs are pushed past it while everything else (badges, boards) stays below.
 */
export function setDeskLamps(intensity: number) {
  const night = intensity > 0.5;
  poolMat.opacity = Math.min(0.55, intensity * 0.3);
  poolMat.visible = night;
  lampBulbMat.color.set(night ? '#ffe2b0' : '#d9d4cc');
  if (night) lampBulbMat.color.multiplyScalar(3.2);
  screenBoost = night ? 1.5 : 1;
  for (const m of screenMats) m.color.setScalar(screenBoost);
}

/**
 * A desk, monitor, chair and a few personal things. Lives in room space at the
 * agent's seat, rotated so the desk is in front of the agent.
 */
export class Workstation {
  readonly root = new Group();
  readonly screen: Screen;
  private chair = new Group();
  private screenMat: MeshBasicMaterial;
  private target: Seat | null = null;
  private report = new Group();
  private reportMat = new MeshStandardMaterial({ color: '#f4e9c9', roughness: 0.85 });

  constructor(agent: Agent) {
    const h = hash(agent.id);
    reseed(h);
    this.screen = new Screen(h % 97);
    // Fixed colours so the whole desk bakes into one mesh.
    const wood = clay('#c9a77f', { roughness: 0.75 });
    const metal = clay('#9aa3ae', { roughness: 0.45 });
    const dark = clay('#2d3340');
    const screenOff = clay('#1b1f27', { roughness: 0.3 });
    const k = new Kit();

    // Desk: top, side panels, modesty panel, cable tray. Desk frame is in front (-Z).
    k.push(0, 0, -DESK_OFFSET);
    k.add(G.rbox(DESK_W, 0.05, DESK_D, 0.02), wood, 0, DESK_H, 0);
    for (const side of [-1, 1]) k.add(G.rbox(0.05, DESK_H - 0.02, DESK_D - 0.08, 0.015), metal, side * (DESK_W / 2 - 0.06), (DESK_H - 0.02) / 2, 0);
    k.add(G.box(DESK_W - 0.16, 0.34, 0.02), metal, 0, DESK_H - 0.24, -DESK_D / 2 + 0.06);
    k.add(G.box(0.9, 0.06, 0.12), dark, 0, DESK_H - 0.12, -0.2, { cast: false });

    // Main monitor frame (the live screen is a separate mesh below).
    const dual = h % 5 < 2;
    const mx = dual ? -0.2 : 0;
    k.push(mx, DESK_H + 0.025, -0.18);
    k.add(G.rbox(0.22, 0.02, 0.14, 0.008), dark, 0, 0.01, 0);
    k.add(G.rbox(0.04, 0.2, 0.03, 0.01), dark, 0, 0.11, -0.02);
    k.add(G.rbox(0.66, 0.42, 0.035, 0.02), screenOff, 0, 0.37, 0);
    // Sticky notes on the bezel
    const notes = Math.floor(rand() * 3);
    for (let i = 0; i < notes; i++) k.add(G.box(0.06, 0.06, 0.004), clay(NOTE_COLORS[(h + i) % NOTE_COLORS.length]), 0.3 - i * 0.07, 0.2 + (i % 2) * 0.02, 0.02, { rz: (rand() - 0.5) * 0.3, cast: false });
    k.pop();
    if (dual) {
      // Second monitor, angled in, showing docs / a terminal / a diff / a chart.
      k.push(0.45, DESK_H + 0.025, -0.13, -0.4);
      k.add(G.rbox(0.18, 0.02, 0.12, 0.008), dark, 0, 0.01, 0);
      k.add(G.rbox(0.04, 0.18, 0.03, 0.01), dark, 0, 0.1, -0.02);
      k.add(G.rbox(0.5, 0.33, 0.03, 0.015), screenOff, 0, 0.33, 0);
      k.add(new PlaneGeometry(0.46, 0.29), sideScreenMaterial(h >> 3), 0, 0.33, 0.017, { cast: false });
      k.pop();
    } else if (h % 5 === 2) {
      // An open laptop to the side
      k.push(0.48, DESK_H + 0.025, 0.02, -0.35);
      k.add(G.rbox(0.32, 0.015, 0.22, 0.008), metal, 0, 0.008, 0);
      k.add(G.rbox(0.32, 0.21, 0.01, 0.008), metal, 0, 0.11, -0.11, { rx: -0.25 });
      k.add(new PlaneGeometry(0.28, 0.17), sideScreenMaterial((h >> 3) + 1), 0, 0.112, -0.103, { rx: -0.25, cast: false });
      k.pop();
    }

    // Keyboard and mouse
    k.add(G.rbox(0.46, 0.022, 0.15, 0.008), clay('#e9ecf1'), -0.04, DESK_H + 0.035, 0.17);
    for (let i = 0; i < 4; i++) k.add(G.box(0.42, 0.004, 0.022), clay('#cfd5dd'), -0.04, DESK_H + 0.048, 0.12 + i * 0.032, { cast: false });
    k.add(G.rbox(0.06, 0.025, 0.1, 0.02), clay('#e9ecf1'), 0.3, DESK_H + 0.036, 0.17);
    k.add(G.rbox(0.24, 0.004, 0.2, 0.01), dark, 0.3, DESK_H + 0.027, 0.17, { cast: false });

    // Personal things: a mug, a notebook and pen, maybe headphones, books, a photo, a cactus, a rubber duck.
    const mugColors = ['#e07a5f', '#3d5a80', '#81b29a', '#f2cc8f', '#ffffff', '#6d597a'];
    k.add(G.cyl(0.045, 0.04, 0.1, 16), clay(mugColors[h % mugColors.length]), -0.6, DESK_H + 0.075, 0.12);
    k.add(G.capsule(0.012, 0.03), clay(mugColors[h % mugColors.length]), -0.55, DESK_H + 0.08, 0.12, { rz: Math.PI / 2 });
    k.add(G.rbox(0.16, 0.012, 0.22, 0.004), clay(['#1e2430', '#c8734f', '#3d5a80'][h % 3]), -0.42, DESK_H + 0.031, 0.2, { ry: 0.25 });
    k.add(G.capsule(0.005, 0.13), clay('#22252b'), -0.4, DESK_H + 0.042, 0.2, { rz: Math.PI / 2, ry: 0.6 });
    if (rand() > 0.4) {
      // Pen cup
      k.add(G.cyl(0.035, 0.035, 0.09, 12), dark, -0.62, DESK_H + 0.07, -0.18);
      for (let i = 0; i < 3; i++) k.add(G.cyl(0.005, 0.005, 0.14, 4), clay(['#d64545', '#3d5a80', '#22252b'][i]), -0.62 + (i - 1) * 0.012, DESK_H + 0.14, -0.18, { rz: (i - 1) * 0.15 });
    }
    if (rand() > 0.55) {
      // Headphones lying on the desk
      k.add(G.cyl(0.05, 0.05, 0.035, 14), dark, 0.42, DESK_H + 0.045, 0.02, { rx: Math.PI / 2, rz: 0.3 });
      k.add(G.cyl(0.05, 0.05, 0.035, 14), dark, 0.58, DESK_H + 0.045, -0.06, { rx: Math.PI / 2, rz: 0.3 });
    }
    if (rand() > 0.5) {
      for (let i = 0; i < 3; i++) k.add(G.box(0.2 - i * 0.015, 0.035, 0.26 - i * 0.02), clay(['#3d5a80', '#e07a5f', '#f2cc8f'][i]), 0.52 * (dual ? -1 : 1), DESK_H + 0.045 + i * 0.036, -0.2, { ry: (rand() - 0.5) * 0.4 });
    }
    if (rand() > 0.6) {
      // Photo frame
      k.add(G.box(0.12, 0.15, 0.015), clay('#22252b'), -0.45, DESK_H + 0.1, -0.25, { rx: -0.2, ry: 0.4 });
      k.add(new PlaneGeometry(0.1, 0.12), posterMaterial(h), -0.445, DESK_H + 0.1, -0.24, { rx: -0.2, ry: 0.4, cast: false });
    }
    if (h % 7 === 0) {
      // The rubber duck. Every codebase has one.
      k.add(G.sphere(0.04, 12, 10), clay('#ffd23f'), 0.2, DESK_H + 0.06, 0.02, { sx: 1.2 });
      k.add(G.sphere(0.028, 10, 8), clay('#ffd23f'), 0.23, DESK_H + 0.11, 0.02);
      k.add(G.capsule(0.01, 0.02), clay('#ff8c1a'), 0.26, DESK_H + 0.105, 0.02, { rz: Math.PI / 2 });
    } else if (h % 3 === 0) {
      plantSmall(k, 0.55, DESK_H + 0.025, -0.24);
    }

    // Desk lamp with a warm pool of light at night
    const lampX = (h & 1 ? 1 : -1) * 0.6;
    if (!dual || lampX < 0) {
      k.add(G.cyl(0.06, 0.07, 0.02, 16), dark, lampX, DESK_H + 0.035, -0.25);
      k.add(G.cyl(0.012, 0.012, 0.36, 8), dark, lampX, DESK_H + 0.2, -0.25, { rz: 0.15 * Math.sign(lampX) });
      k.add(G.cyl(0.035, 0.08, 0.08, 16), dark, lampX - 0.03 * Math.sign(lampX), DESK_H + 0.38, -0.21, { rx: 0.5 });
      k.add(G.sphere(0.03, 10, 8), lampBulbMat, lampX - 0.03 * Math.sign(lampX), DESK_H + 0.35, -0.19, { cast: false });
      k.add(poolGeo, poolMat, lampX * 0.4, DESK_H + 0.03, -0.02, { rx: -Math.PI / 2, cast: false });
    }

    // Under the desk: a backpack sometimes
    if (rand() > 0.5) {
      const bag = ['#3d5a80', '#2d3340', '#c8734f', '#7d8f69'][h % 4];
      k.add(G.rbox(0.3, 0.38, 0.18, 0.07), clay(bag), 0.5, 0.19, 0.1, { ry: 0.4 });
      k.add(G.rbox(0.22, 0.16, 0.06, 0.04), clay(bag), 0.47, 0.14, 0.2, { ry: 0.4 });
    }
    k.pop();
    const desk = k.build();
    this.root.add(desk);

    // ENG-160: optional dry-run report on the desk. Hidden in every normal floor.
    const paper = new Mesh(new PlaneGeometry(0.28, 0.38), this.reportMat);
    paper.rotation.x = -Math.PI / 2;
    paper.rotation.z = 0.12;
    this.report.add(paper);
    this.report.position.set(0.34, DESK_H + 0.058, -0.64);
    this.report.visible = false;
    this.root.add(this.report);

    // Live screen
    this.screenMat = new MeshBasicMaterial({ map: this.screen.texture, toneMapped: false });
    this.screenMat.color.setScalar(screenBoost);
    screenMats.add(this.screenMat);
    const scr = new Mesh(screenGeo, this.screenMat);
    scr.position.set(mx, DESK_H + 0.025 + 0.37, -DESK_OFFSET - 0.18 + 0.019);
    this.root.add(scr);

    // Chair: seat, back, armrests, gas lift, star base with casters.
    const ck = new Kit();
    const fabric = clay(['#2d3340', '#3a4a5c', '#4a3f4f', '#2f4a45'][(h >> 5) % 4]);
    ck.add(G.rbox(0.5, 0.08, 0.46, 0.04), fabric, 0, 0.46, 0.04);
    ck.add(G.rbox(0.48, 0.52, 0.07, 0.05), fabric, 0, 0.8, 0.29, { rx: 0.08 });
    for (const sx of [-1, 1]) {
      ck.add(G.box(0.03, 0.18, 0.03), dark, sx * 0.26, 0.56, 0.1);
      ck.add(G.rbox(0.06, 0.03, 0.24, 0.012), dark, sx * 0.26, 0.66, 0.06);
    }
    ck.add(G.cyl(0.03, 0.03, 0.3, 10), metal, 0, 0.28, 0.04);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ck.add(G.box(0.04, 0.035, 0.26), metal, Math.sin(a) * 0.13, 0.08, 0.04 + Math.cos(a) * 0.13, { ry: a });
      ck.add(G.sphere(0.025, 8, 6), dark, Math.sin(a) * 0.26, 0.03, 0.04 + Math.cos(a) * 0.26);
    }
    this.chair.add(ck.build());
    this.root.add(this.chair);

    this.root.traverse((o) => {
      o.userData.agentId = agent.id;
    });
  }

  setSeat(seat: Seat, instant = false) {
    this.target = seat;
    if (instant) {
      this.root.position.set(seat.x, 0, seat.z);
      this.root.rotation.y = seat.yaw;
    }
  }

  update(dt: number, t: number, agent: Agent, dark: boolean, charSeated: boolean, charYaw: number, near = true) {
    if (this.target) {
      this.root.position.x = damp(this.root.position.x, this.target.x, 6, dt);
      this.root.position.z = damp(this.root.position.z, this.target.z, 6, dt);
      this.root.rotation.y = dampAngle(this.root.rotation.y, this.target.yaw, 6, dt);
      // The chair swivels with whoever sits in it, and tucks in when empty.
      const swivel = charSeated ? charYaw - this.target.yaw : 0;
      this.chair.rotation.y = dampAngle(this.chair.rotation.y, swivel, 8, dt);
      this.chair.position.z = damp(this.chair.position.z, charSeated ? 0 : 0.35, 4, dt);
    }
    if (near) this.screen.update(agent, t, dark);
  }

  setReport(status: 'ready' | 'rejected' | null) {
    this.report.visible = Boolean(status);
    this.reportMat.color.set(status === 'rejected' ? '#b94b43' : '#f4e9c9');
  }

  dispose() {
    this.screen.dispose();
    screenMats.delete(this.screenMat);
    this.screenMat.dispose();
    this.reportMat.dispose();
    this.root.removeFromParent();
  }
}
