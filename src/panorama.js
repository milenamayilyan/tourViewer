import * as THREE from 'three';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Minimal Marzipano-like equirectangular viewer.
 * The camera sits at the centre of a sphere; the photo is mapped to its inside.
 * yaw 0 / pitch 0 looks at the exact centre of the image.
 */
export class PanoramaViewer {
  constructor(container, opts = {}) {
    this.o = { autoSpeed: 3, resumeDelay: 4000, fov: 75, minFov: 30, maxFov: 100, fade: 1100, cacheSize: 3, ...opts };
    this.container = container;
    this.onLoading = () => {};
    this.onFrame = () => {};

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.o.fov, 1, 0.1, 1100);

    const geo = new THREE.SphereGeometry(500, 64, 48);
    geo.scale(-1, 1, 1); // render the inside, un-mirrored
    const mk = (order) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
      m.visible = false; m.renderOrder = order;
      this.scene.add(m);
      return m;
    };
    this.cur = mk(0);
    this.nxt = mk(1);

    this.yaw = this.tYaw = 0;
    this.pitch = this.tPitch = 0;
    this.fov = this.tFov = this.o.fov;
    this.vYaw = this.vPitch = 0;
    this.bump = 0;
    this.autoRotate = true;
    this.autoF = 0;
    this.lastInput = -1e9;
    this.dragging = false;
    this.trans = null;
    this.cache = new Map();
    this.last = 0;

    this._bind();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    requestAnimationFrame(this._tick);
  }

  setAutoRotate(on) { this.autoRotate = on; if (on) this.lastInput = -1e9; }
  zoom(delta) { this.tFov = clamp(this.tFov + delta, this.o.minFov, this.o.maxFov); }

  /** Screen position (px, relative to the viewer) of a direction given in radians. */
  project(yaw, pitch) {
    const cp = Math.cos(pitch);
    const v = new THREE.Vector3(-Math.cos(yaw) * cp, Math.sin(pitch), -Math.sin(yaw) * cp).multiplyScalar(400).project(this.camera);
    return {
      x: ((v.x + 1) / 2) * this.container.clientWidth,
      y: ((1 - v.y) / 2) * this.container.clientHeight,
      visible: v.z < 1 && Math.abs(v.x) < 1.3 && Math.abs(v.y) < 1.3,
    };
  }

  /** Direction (radians) under a screen point. */
  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5)
      .unproject(this.camera).normalize();
    return { yaw: Math.atan2(-v.z, -v.x), pitch: Math.asin(v.y) };
  }

  /** Hide the current panorama (used when switching to an empty project). */
  clear() { this.cur.visible = false; this.cur.material.opacity = 0; }

  _touch() { this.lastInput = performance.now(); }

  /** Load a panorama and crossfade to it. Rejects if the image can't be loaded. */
  async goTo(url, { yaw } = {}) {
    this.onLoading(true);
    let tex;
    try { tex = await this._load(url); } finally { this.onLoading(false); }
    if (yaw !== undefined) this.tYaw = yaw * D2R;
    return new Promise((resolve) => {
      this.nxt.material.map = tex;
      this.nxt.material.needsUpdate = true;
      this.nxt.material.opacity = 0;
      this.nxt.visible = true;
      this.trans = { t0: performance.now(), resolve };
    });
  }

  /** Warm the HTTP cache for an image without uploading it to the GPU. */
  preload(url) { const i = new Image(); i.decoding = 'async'; i.src = url; }

  _load(url) {
    if (this.cache.has(url)) {
      const t = this.cache.get(url); this.cache.delete(url); this.cache.set(url, t);
      return Promise.resolve(t);
    }
    return new Promise((res, rej) => {
      new THREE.TextureLoader().load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        this.cache.set(url, t);
        this._trim();
        res(t);
      }, undefined, () => rej(new Error('Failed to load ' + url)));
    });
  }

  _trim() {
    for (const [k, t] of this.cache) {
      if (this.cache.size <= this.o.cacheSize) break;
      if (t === this.cur.material.map || t === this.nxt.material.map) continue;
      t.dispose(); this.cache.delete(k);
    }
  }

  _bind() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    const ptrs = (this.ptrs = new Map());
    let pinch0 = 0, fov0 = 0, lastMove = 0;
    const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragging = true; this.vYaw = this.vPitch = 0; this._touch();
      if (ptrs.size === 2) { pinch0 = dist(); fov0 = this.tFov; }
    });

    el.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      this._touch();
      if (ptrs.size >= 2) { this.tFov = clamp(fov0 * (pinch0 / dist()), this.o.minFov, this.o.maxFov); return; }
      const k = (this.fov * D2R) / this.container.clientHeight;
      const dYaw = -dx * k, dPitch = dy * k;
      this.tYaw += dYaw;
      this.tPitch = clamp(this.tPitch + dPitch, -85 * D2R, 85 * D2R);
      const dt = Math.max(1, e.timeStamp - lastMove) / 1000;
      this.vYaw = clamp(dYaw / dt, -6, 6); this.vPitch = clamp(dPitch / dt, -6, 6);
      lastMove = e.timeStamp;
    });

    const up = (e) => {
      ptrs.delete(e.pointerId);
      this.dragging = ptrs.size > 0;
      if (e.timeStamp - lastMove > 80 || ptrs.size === 1) this.vYaw = this.vPitch = 0;
      this._touch();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY * 0.04); this._touch(); }, { passive: false });
  }

  _resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick = (now) => {
    requestAnimationFrame(this._tick);
    const dt = Math.min(0.05, (now - this.last) / 1000 || 0);
    this.last = now;

    const idle = now - this.lastInput > this.o.resumeDelay;
    const want = this.autoRotate && !this.dragging && idle ? 1 : 0;
    this.autoF += (want - this.autoF) * (1 - Math.exp(-dt * 2));
    this.tYaw += this.o.autoSpeed * D2R * this.autoF * dt;

    if (!this.dragging) {
      this.tYaw += this.vYaw * dt;
      this.tPitch = clamp(this.tPitch + this.vPitch * dt, -85 * D2R, 85 * D2R);
      const decay = Math.exp(-dt * 4);
      this.vYaw *= decay; this.vPitch *= decay;
    }

    const s = 1 - Math.exp(-dt * 10);
    this.yaw += (this.tYaw - this.yaw) * s;
    this.pitch += (this.tPitch - this.pitch) * s;
    this.fov += (this.tFov - this.fov) * s;

    if (this.trans) {
      const p = clamp((now - this.trans.t0) / this.o.fade, 0, 1);
      this.nxt.material.opacity = ease(p);
      this.bump = -10 * Math.sin(Math.PI * p);
      if (p >= 1) {
        [this.cur, this.nxt] = [this.nxt, this.cur];
        this.cur.material.opacity = 1; this.cur.renderOrder = 0;
        this.nxt.visible = false; this.nxt.material.opacity = 0; this.nxt.renderOrder = 1;
        this.bump = 0;
        const done = this.trans.resolve; this.trans = null;
        this._trim(); done();
      }
    }

    this.camera.fov = this.fov + this.bump;
    this.camera.updateProjectionMatrix();
    const cp = Math.cos(this.pitch);
    this.camera.lookAt(-Math.cos(this.yaw) * cp, Math.sin(this.pitch), -Math.sin(this.yaw) * cp);
    this.renderer.render(this.scene, this.camera);
    this.onFrame();
  };
}
