import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

const DIRECTION_LABELS = {
  approaching: "靠近",
  retreating: "远离",
  stationary: "静止",
  unknown: "未知",
};

const DIR_COLORS = {
  approaching: 0xef4444,
  retreating: 0x22c55e,
  stationary: 0x8b9cb3,
  unknown: 0xf59e0b,
};

const MAX_TRAIL_POINTS = 200;
const MODEL_URL = "/static/models/Human.glb";
const MODEL_SCALE = 1.0;
const MODEL_Y_OFFSET = 0;
/** Mixamo Xbot 默认面朝 +Z */
const MODEL_FACING_Y = 0;
const WS_RECONNECT_MS = 1500;

/** 小于此位移（米）视为检测噪声，忽略 */
const POS_DEADZONE = 0.1;
/** 开始走路的距离阈值（保留备用） */
const WALK_START_DIST = 0.28;
/** 小于此距离视为贴住目标 */
const WALK_STOP_DIST = 0.08;
/** 检测速度低于此视为静止 */
const IDLE_SPEED = 0.25;
const RUN_SPEED = 2.2;
/** 走路动画对应的标称步速（米/秒） */
const WALK_PACE = 1.2;
/** 追目标最低移动速度 */
const MIN_CHASE_SPEED = 0.85;
/** 目标点平滑 */
const TARGET_FOLLOW = 5.0;
/** 检测位移超过此值才计入行进方向（米） */
const TRAVEL_MIN_STEP = 0.08;
/** 行进方向 EMA */
const TRAVEL_DIR_ALPHA = 0.4;
/** 朝向小幅修正阈值（弧度） */
const HEADING_SNAP_RAD = 0.5;
/** 中等转向确认时间 */
const HEADING_TURN_MS = 180;
/** 大角度转向确认时间 */
const HEADING_FLIP_MS = 450;
/** 朝向转动速度 */
const HEADING_TURN = 4.0;
/** 用追赶偏移补朝向的最小距离 */
const HEADING_FALLBACK_DIST = 0.45;
/** 跟踪丢失后宽限期（毫秒），超时后开始自然离场 */
const LOST_GRACE_MS = 3000;
/** 出场淡入时长（秒） */
const SPAWN_FADE_SEC = 0.7;
/** 离场淡出时长（秒） */
const EXIT_FADE_SEC = 0.9;
/** 出场时相对检测点的外侧偏移（米），避免凭空出现 */
const SPAWN_OFFSET_M = 2.4;
/** 材质不透明度上限（与轨迹线峰值一致） */
const MODEL_OPACITY = 1;
const TRAIL_OPACITY = 0.85;

/**
 * 人员落点用标定原点地面直角坐标，不用极径距离 D。
 *   ground_x  横向（标定：左负右正）
 *   ground_y  纵深
 * Three.js：水平面 (worldX, worldZ) = (-ground_x, ground_y)，竖直为 worldY。
 * 对 X 取反，使从 +Z 方向看时与监控画面左右一致。
 */
function toWorldPos(groundX, groundY, out) {
  out.set(-groundX, 0, groundY);
  return out;
}

const viewport = document.getElementById("viewport");
const placeholder = document.getElementById("viewportPlaceholder");
const personList = document.getElementById("personList");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetCamBtn = document.getElementById("resetCamBtn");
const clearTrailBtn = document.getElementById("clearTrailBtn");
const followCam = document.getElementById("followCam");
const showCoords = document.getElementById("showCoords");
const videoPip = document.getElementById("videoPip");
const videoPipWrap = document.getElementById("videoPipWrap");
const videoPipToggle = document.getElementById("videoPipToggle");
const fpsBadge = document.getElementById("fpsBadge");
const detectBadge = document.getElementById("detectBadge");
const messageBox = document.getElementById("messageBox");

let scene, camera, renderer, labelRenderer, controls, clock;
let templateModel = null;
let templateAnimations = null;
let modelReady = false;
let ws = null;
let wsWanted = false;
let wsReconnectTimer = null;
let animFrameId = null;
let sceneReady = false;

/** @type {Map<number, PersonAgent>} */
const agents = new Map();

class PersonAgent {
  constructor(personId, template, animations) {
    this.personId = personId;
    this.group = new THREE.Group();
    this.group.name = `person_${personId}`;

    this._materials = [];
    this.model = cloneSkinned(template);
    this.model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          const cloned = mats.map((m) => {
            const c = m.clone();
            c.transparent = true;
            c.opacity = 0;
            c.depthWrite = c.opacity >= 0.99;
            this._materials.push(c);
            return c;
          });
          obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
        }
      }
    });
    this.model.scale.setScalar(MODEL_SCALE * 0.92);
    this.model.position.y = MODEL_Y_OFFSET;
    this.model.rotation.y = MODEL_FACING_Y;
    this.group.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of animations) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      this.actions[clip.name] = action;
      this.actions[clip.name.toLowerCase()] = action;
    }
    this.currentAction = null;
    this._play("Idle");

    this.target = new THREE.Vector3(0, 0, 0);
    this.smooth = new THREE.Vector3(0, 0, 0);
    this._rawTarget = new THREE.Vector3(0, 0, 0);
    this.heading = 0;
    this.displaySpeed = 0;
    this.speed = 0;
    this.direction = "unknown";
    this.distance = 0;
    this.camX = 0;
    this.camY = 0;
    this.trailPoints = [];
    this.lastSeen = performance.now();
    this._moving = false;
    this._walking = false;
    this._initialized = false;
    this._prevSmooth = new THREE.Vector3();
    this._prevRaw = new THREE.Vector3();
    this._locoUntil = 0;
    this._travelX = 0;
    this._travelZ = 1;
    this._travelValid = false;
    this._pendingHeading = null;
    this._pendingSince = 0;

    /** spawning | active | exiting | disposed */
    this.life = "spawning";
    this._fade = 0;
    this._disposed = false;

    this.trailGeom = new THREE.BufferGeometry();
    this.trailMat = new THREE.LineBasicMaterial({
      color: DIR_COLORS.unknown,
      transparent: true,
      opacity: 0,
    });
    this.trailLine = new THREE.Line(this.trailGeom, this.trailMat);
    this.trailLine.frustumCulled = false;

    const labelEl = document.createElement("div");
    labelEl.className = "person-label unknown";
    labelEl.textContent = `#${personId}`;
    labelEl.style.opacity = "0";
    this.label = new CSS2DObject(labelEl);
    this.label.position.set(0, 1.9, 0);
    this.group.add(this.label);

    scene.add(this.group);
    scene.add(this.trailLine);
  }

  _setVisualFade(t) {
    const a = THREE.MathUtils.clamp(t, 0, 1);
    this._fade = a;
    for (const mat of this._materials) {
      mat.opacity = a * MODEL_OPACITY;
      mat.depthWrite = a >= 0.95;
      mat.transparent = a < 0.99;
    }
    this.trailMat.opacity = a * TRAIL_OPACITY;
    if (this.label?.element) {
      this.label.element.style.opacity = String(a);
    }
    const s = THREE.MathUtils.lerp(0.92, 1, a);
    this.model.scale.setScalar(MODEL_SCALE * s);
  }

  /**
   * 从检测点外侧走进：先放在落点更外侧，再追赶真实目标，并淡入。
   */
  beginSpawn(detectPos) {
    const ox = detectPos.x;
    const oz = detectPos.z;
    const len = Math.hypot(ox, oz);
    let nx;
    let nz;
    if (len > 0.4) {
      nx = ox / len;
      nz = oz / len;
    } else {
      // 靠近原点时默认从相机一侧（-Z）走进
      nx = 0;
      nz = -1;
    }
    this.smooth.set(ox + nx * SPAWN_OFFSET_M, 0, oz + nz * SPAWN_OFFSET_M);
    this.target.copy(detectPos);
    this._rawTarget.copy(detectPos);
    this._prevRaw.copy(detectPos);
    this._prevSmooth.copy(this.smooth);
    this.group.position.copy(this.smooth);

    this._travelX = -nx;
    this._travelZ = -nz;
    this._travelValid = true;
    this.heading = Math.atan2(this._travelX, this._travelZ);
    this.group.rotation.y = this.heading;
    this._locoUntil = performance.now() + 1200;
    this._initialized = true;
    this.life = "spawning";
    this._setVisualFade(0);
  }

  beginExit() {
    if (this.life === "exiting" || this.life === "disposed") return;
    this.life = "exiting";
    // 无行进方向时沿远离原点方向离开
    if (!this._travelValid) {
      const len = Math.hypot(this.smooth.x, this.smooth.z);
      if (len > 0.2) {
        this._travelX = this.smooth.x / len;
        this._travelZ = this.smooth.z / len;
      } else {
        this._travelX = 0;
        this._travelZ = 1;
      }
      this._travelValid = true;
    }
    this.heading = Math.atan2(this._travelX, this._travelZ);
    this._play("Walk");
  }

  /** 跟踪恢复：取消离场，淡回可见 */
  cancelExit() {
    if (this.life !== "exiting") return;
    this.life = this._fade >= 0.98 ? "active" : "spawning";
  }

  _resolveAction(name) {
    const aliases = {
      Idle: ["Idle", "idle", "HappyIdle", "Sway"],
      Walk: ["Walk", "walk"],
      Run: ["Run", "run", "Walk", "walk"],
    };
    for (const key of aliases[name] || [name]) {
      if (this.actions[key]) return this.actions[key];
    }
    const lower = String(name).toLowerCase();
    if (this.actions[lower]) return this.actions[lower];
    return this.actions.Idle || this.actions.idle || Object.values(this.actions)[0];
  }

  _play(name) {
    const next = this._resolveAction(name);
    if (!next) return;
    if (this.currentAction === next) return;
    if (this.currentAction) {
      this.currentAction.fadeOut(0.2);
    }
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.fadeIn(0.2).play();
    this.currentAction = next;
    this._currentAnimName = name;
  }

  updateFromApi(p) {
    this.camX = p.ground_x;
    this.camY = p.ground_y;
    toWorldPos(this.camX, this.camY, this._rawTarget);
    this.speed = p.speed || 0;
    this.direction = p.direction || "unknown";
    this.distance = p.distance || 0;
    this.lastSeen = performance.now();

    if (this.life === "exiting") {
      this.cancelExit();
    }

    if (!this._initialized) {
      this.beginSpawn(this._rawTarget.clone());
    } else if (this.life !== "exiting") {
      const dx = this._rawTarget.x - this._prevRaw.x;
      const dz = this._rawTarget.z - this._prevRaw.z;
      const rawJump = Math.hypot(dx, dz);
      this._prevRaw.copy(this._rawTarget);

      if (rawJump >= 0.04 || this.speed >= IDLE_SPEED) {
        this._locoUntil = performance.now() + 500;
      }

      // 用检测点真实位移更新行进方向（比追赶偏移更稳，避免个别人朝向反了）
      if (rawJump >= TRAVEL_MIN_STEP) {
        const ndx = dx / rawJump;
        const ndz = dz / rawJump;
        if (!this._travelValid) {
          this._travelX = ndx;
          this._travelZ = ndz;
          this._travelValid = true;
          this.heading = Math.atan2(ndx, ndz);
          this.group.rotation.y = this.heading;
        } else {
          const align = this._travelX * ndx + this._travelZ * ndz;
          if (align > -0.15) {
            const a = TRAVEL_DIR_ALPHA;
            this._travelX = this._travelX * (1 - a) + ndx * a;
            this._travelZ = this._travelZ * (1 - a) + ndz * a;
            const len = Math.hypot(this._travelX, this._travelZ) || 1;
            this._travelX /= len;
            this._travelZ /= len;
          } else {
            // 疑似掉头：慢一点混入，避免噪声瞬间反向
            const a = 0.15;
            this._travelX = this._travelX * (1 - a) + ndx * a;
            this._travelZ = this._travelZ * (1 - a) + ndz * a;
            const len = Math.hypot(this._travelX, this._travelZ) || 1;
            this._travelX /= len;
            this._travelZ /= len;
          }
        }
      }

      const jump = this._rawTarget.distanceTo(this.target);
      if (jump >= POS_DEADZONE) {
        this.target.lerp(this._rawTarget, 0.55);
      }
    }

    const color = DIR_COLORS[this.direction] ?? DIR_COLORS.unknown;
    this.trailMat.color.setHex(color);

    const el = this.label.element;
    el.className = `person-label ${this.direction}`;
    const speedStr = `${this.speed.toFixed(1)} m/s`;
    if (showCoords?.checked) {
      el.textContent = `#${this.personId}  ${speedStr}  x:${this.camX.toFixed(1)}  y:${this.camY.toFixed(1)}`;
    } else {
      el.textContent = `#${this.personId}  ${speedStr}`;
    }
  }

  _angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  _updateHeading(desired, now) {
    const diff = Math.abs(this._angleDiff(desired, this.heading));
    if (diff < HEADING_SNAP_RAD) {
      this.heading = desired;
      this._pendingHeading = null;
      this._pendingSince = 0;
      return;
    }
    const needMs = diff > Math.PI * 0.6 ? HEADING_FLIP_MS : HEADING_TURN_MS;
    if (
      this._pendingHeading == null ||
      Math.abs(this._angleDiff(desired, this._pendingHeading)) > Math.PI / 4
    ) {
      this._pendingHeading = desired;
      this._pendingSince = now;
      return;
    }
    if (now - this._pendingSince >= needMs) {
      this.heading = desired;
      this._pendingHeading = null;
      this._pendingSince = 0;
    }
  }

  tick(dt) {
    if (this._disposed) return;

    if (!this._initialized) {
      this.mixer.update(dt);
      return;
    }

    // 出场淡入 / 离场淡出
    if (this.life === "spawning") {
      this._setVisualFade(this._fade + dt / SPAWN_FADE_SEC);
      if (this._fade >= 1) {
        this._setVisualFade(1);
        this.life = "active";
      }
    } else if (this.life === "exiting") {
      this._setVisualFade(this._fade - dt / EXIT_FADE_SEC);
    }

    this._prevSmooth.copy(this.smooth);
    const now = performance.now();

    if (this.life === "exiting") {
      // 沿最后行进方向继续走远，同时淡出
      const v = WALK_PACE;
      const step = v * dt;
      this.smooth.x += this._travelX * step;
      this.smooth.z += this._travelZ * step;
      this.displaySpeed = v;
      this._moving = true;
      this._walking = true;
      this._updateHeading(Math.atan2(this._travelX, this._travelZ), now);

      const curY = this.group.rotation.y;
      const diff = this._angleDiff(this.heading, curY);
      this.group.rotation.y = curY + diff * Math.min(1, HEADING_TURN * dt);
      this.group.position.copy(this.smooth);

      this._play("Walk");
      if (this.currentAction) {
        this.currentAction.setEffectiveTimeScale(1);
      }
      this.mixer.update(dt);

      const last = this.trailPoints[this.trailPoints.length - 1];
      if (!last || last.distanceTo(this.smooth) > 0.35) {
        this.trailPoints.push(this.smooth.clone());
        if (this.trailPoints.length > MAX_TRAIL_POINTS) {
          this.trailPoints.shift();
        }
        this.trailGeom.setFromPoints(this.trailPoints);
      }

      if (this._fade <= 0) {
        this.dispose();
      }
      return;
    }

    this.target.x += (this._rawTarget.x - this.target.x) * Math.min(1, TARGET_FOLLOW * dt);
    this.target.z += (this._rawTarget.z - this.target.z) * Math.min(1, TARGET_FOLLOW * dt);

    const offsetX = this.target.x - this.smooth.x;
    const offsetZ = this.target.z - this.smooth.z;
    const dist = Math.hypot(offsetX, offsetZ);

    const locoActive = now < this._locoUntil;
    const shouldWalk = dist > WALK_STOP_DIST || locoActive || this.life === "spawning";

    if (shouldWalk) {
      this._walking = true;
      let v = this.speed;
      if (!(v >= MIN_CHASE_SPEED)) v = WALK_PACE;
      v = THREE.MathUtils.clamp(v, MIN_CHASE_SPEED, 4.5);
      if (dist > 2.5) v = Math.max(v, Math.min(dist * 0.6, 3.2));

      if (dist > 0.02) {
        const step = Math.min(dist, v * dt);
        const inv = 1 / dist;
        this.smooth.x += offsetX * inv * step;
        this.smooth.z += offsetZ * inv * step;
      }
      this.displaySpeed = v;
      this._moving = true;
    } else {
      this.smooth.x = this.target.x;
      this.smooth.z = this.target.z;
      this.displaySpeed = 0;
      this._moving = false;
      this._walking = false;
    }

    // 朝向优先用检测行进方向；仅在尚无行进样本且离目标较远时用追赶偏移兜底
    if (this._walking) {
      if (this._travelValid) {
        this._updateHeading(Math.atan2(this._travelX, this._travelZ), now);
      } else if (dist >= HEADING_FALLBACK_DIST) {
        this._updateHeading(Math.atan2(offsetX, offsetZ), now);
      }
    }

    const curY = this.group.rotation.y;
    const diff = this._angleDiff(this.heading, curY);
    this.group.rotation.y = curY + diff * Math.min(1, HEADING_TURN * dt);
    this.group.position.copy(this.smooth);

    if (this._walking) {
      if (this.displaySpeed >= RUN_SPEED) {
        this._play("Run");
        if (this.currentAction) {
          // 无独立 Run 时回退 Walk，略加快步频
          const base = this._currentAnimName === "Run" && this.actions.Run ? 3.5 : WALK_PACE;
          this.currentAction.setEffectiveTimeScale(
            THREE.MathUtils.clamp(this.displaySpeed / base, 1.05, 1.7),
          );
        }
      } else {
        this._play("Walk");
        if (this.currentAction) {
          this.currentAction.setEffectiveTimeScale(
            THREE.MathUtils.clamp(this.displaySpeed / WALK_PACE, 0.9, 1.3),
          );
        }
      }
    } else {
      this._play("Idle");
    }

    this.mixer.update(dt);

    if (this._walking) {
      const last = this.trailPoints[this.trailPoints.length - 1];
      if (!last || last.distanceTo(this.smooth) > 0.35) {
        this.trailPoints.push(this.smooth.clone());
        if (this.trailPoints.length > MAX_TRAIL_POINTS) {
          this.trailPoints.shift();
        }
        this.trailGeom.setFromPoints(this.trailPoints);
      }
    }
  }

  clearTrail() {
    this.trailPoints = [];
    this.trailGeom.setFromPoints([]);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.life = "disposed";
    scene.remove(this.group);
    scene.remove(this.trailLine);
    this.trailGeom.dispose();
    this.trailMat.dispose();
    this.mixer.stopAllAction();
    if (this.label?.element?.parentNode) {
      this.label.element.parentNode.removeChild(this.label.element);
    }
  }
}

function showError(msg) {
  messageBox.textContent = msg;
  messageBox.hidden = false;
}

function hideError() {
  messageBox.hidden = true;
}

function resetCamera() {
  if (!camera || !controls) return;
  // 站在原点后方稍高处，沿 +Y（世界 +Z）看向场景深处
  camera.position.set(0, 8, -6);
  controls.target.set(0, 0, 12);
  controls.update();
}

function makeAxisLabel(text, color, x, y, z) {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.font = "bold 28px Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, 96, 42);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  sprite.position.set(x, y, z);
  sprite.scale.set(2.8, 0.9, 1);
  scene.add(sprite);
}

function buildGround() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({
      color: 0x1a2332,
      roughness: 0.95,
      metalness: 0.05,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(80, 80, 0x3b82f6, 0x243044);
  grid.position.y = 0.01;
  scene.add(grid);

  // 标定地面坐标轴：X 横向（场景中取反）、Y 纵深（映射到 Three +Z）
  const axisLines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-20, 0.04, 0),
      new THREE.Vector3(20, 0.04, 0),
      new THREE.Vector3(0, 0.04, -2),
      new THREE.Vector3(0, 0.04, 40),
    ]),
    new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.85 }),
  );
  scene.add(axisLines);

  // worldX = -ground_x，标签放在对应世界位置
  makeAxisLabel("X+ →", "#60a5fa", -8, 0.08, 0.5);
  makeAxisLabel("← X-", "#60a5fa", 8, 0.08, 0.5);
  makeAxisLabel("Y →", "#fbbf24", 0.8, 0.08, 12);

  // 原点标记
  const originMark = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.5, 32),
    new THREE.MeshBasicMaterial({ color: 0xf97316, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  originMark.add(ring);
  makeAxisLabel("O", "#f97316", 0, 0.15, -1.2);
  scene.add(originMark);

  // 纵深刻度
  for (const y of [5, 10, 15, 20, 30]) {
    makeAxisLabel(`y=${y}m`, "#8b9cb3", 1.2, 0.06, y);
    const tick = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.02, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.7 }),
    );
    tick.position.set(0, 0.03, y);
    scene.add(tick);
  }

  // 横向刻度（世界位置 = -标定 x）
  for (const x of [-10, -5, 5, 10]) {
    const wx = -x;
    makeAxisLabel(`x=${x}`, "#8b9cb3", wx, 0.06, 1.5);
    const tick = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.02, 1.2),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.7 }),
    );
    tick.position.set(wx, 0.03, 0);
    scene.add(tick);
  }

  const axis = new THREE.AxesHelper(3);
  axis.position.y = 0.05;
  scene.add(axis);
}

async function loadHumanModel() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL);
  templateModel = gltf.scene;
  templateAnimations = gltf.animations;
  templateModel.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  modelReady = true;
}

function initScene() {
  if (sceneReady) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);
  scene.fog = new THREE.Fog(0x0a0e14, 40, 90);

  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera = new THREE.PerspectiveCamera(50, w / Math.max(h, 1), 0.1, 200);
  camera.position.set(0, 8, -6);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(w, h);
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.inset = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  labelRenderer.domElement.style.zIndex = "2";
  viewport.appendChild(labelRenderer.domElement);

  // 确保画中画始终在 canvas / label 之上，可点击放大
  if (videoPipWrap) {
    viewport.appendChild(videoPipWrap);
    videoPipWrap.style.zIndex = "30";
  }

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 12);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2;
  controls.maxDistance = 80;
  // 左键旋转；中键平移；右键仍可平移；滚轮缩放
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.update();

  const hemi = new THREE.HemisphereLight(0xb1c4e0, 0x1a2332, 0.85);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(10, 20, 8);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 1;
  dir.shadow.camera.far = 60;
  dir.shadow.camera.left = -30;
  dir.shadow.camera.right = 30;
  dir.shadow.camera.top = 30;
  dir.shadow.camera.bottom = -30;
  scene.add(dir);

  buildGround();
  clock = new THREE.Clock();
  sceneReady = true;

  window.addEventListener("resize", onResize);
  animate();
}

function onResize() {
  if (!renderer || !camera) return;
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
}

function animate() {
  animFrameId = requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  for (const [id, agent] of [...agents.entries()]) {
    agent.tick(dt);
    if (agent._disposed) agents.delete(id);
  }

  if (followCam.checked && agents.size > 0) {
    let nearest = null;
    let best = Infinity;
    for (const a of agents.values()) {
      if (a.life === "exiting" || a._disposed) continue;
      if (a.distance < best) {
        best = a.distance;
        nearest = a;
      }
    }
    if (nearest) {
      // 跟随：目标点跟随人员，观察相机在其后方
      const t = controls.target;
      t.lerp(new THREE.Vector3(nearest.smooth.x, 1.2, nearest.smooth.z), 0.06);
      const desired = new THREE.Vector3(nearest.smooth.x * 0.3, 7, Math.min(nearest.smooth.z - 10, -2));
      camera.position.lerp(desired, 0.04);
    }
  }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function syncAgents(persons) {
  const liveIds = new Set(persons.map((p) => p.person_id));

  for (const p of persons) {
    let agent = agents.get(p.person_id);
    if (!agent || agent._disposed) {
      if (!modelReady) continue;
      if (agent?._disposed) agents.delete(p.person_id);
      agent = new PersonAgent(p.person_id, templateModel, templateAnimations);
      const spawnAt = new THREE.Vector3();
      toWorldPos(p.ground_x, p.ground_y, spawnAt);
      agent.beginSpawn(spawnAt);
      agents.set(p.person_id, agent);
    }
    agent.updateFromApi(p);
  }

  const now = performance.now();
  for (const [id, agent] of agents) {
    if (agent._disposed) {
      agents.delete(id);
      continue;
    }
    if (!liveIds.has(id) && now - agent.lastSeen > LOST_GRACE_MS) {
      agent.beginExit();
    }
  }
}

function renderPersonList(persons) {
  if (!persons.length) {
    personList.innerHTML = '<li class="point-item" style="color:var(--text-muted)">暂无人员</li>';
    return;
  }
  personList.innerHTML = "";
  persons.forEach((p) => {
    const li = document.createElement("li");
    li.className = "point-item";
    const dir = DIRECTION_LABELS[p.direction] || p.direction;
    let color = "#8b9cb3";
    if (p.direction === "approaching") color = "#ef4444";
    if (p.direction === "retreating") color = "#22c55e";
    li.innerHTML = `
      <span class="label" style="color:${color}">#${p.person_id}</span>
      <span class="meta">
        相对原点 <strong>x=${p.ground_x}</strong>, <strong>y=${p.ground_y}</strong> m<br>
        速度 ${p.speed} m/s · ${dir}
      </span>
    `;
    personList.appendChild(li);
  });
}

function applyStatus(data) {
  fpsBadge.textContent = `FPS: ${data.fps ?? "-"}`;
  const persons = data.persons || [];
  renderPersonList(persons);
  syncAgents(persons);

  if (data.error) showError(data.error);
  else hideError();

  if (data.running) {
    detectBadge.textContent = "运行中";
    detectBadge.className = "badge ok";
  } else if (wsWanted) {
    detectBadge.textContent = "检测已结束";
    detectBadge.className = "badge";
  }
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/detect`;
}

function connectWebSocket() {
  disconnectWebSocket(false);
  wsWanted = true;

  const socket = new WebSocket(wsUrl());
  ws = socket;

  socket.onopen = () => {
    detectBadge.textContent = "运行中";
    detectBadge.className = "badge ok";
    hideError();
  };

  socket.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.type === "status" || data.type === "ping") {
      applyStatus(data);
    } else if (data.type === "error") {
      showError(data.error || "WebSocket 错误");
    }
  };

  socket.onerror = () => {
    showError("WebSocket 连接异常");
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    if (!wsWanted) return;
    detectBadge.textContent = "重连中…";
    detectBadge.className = "badge";
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, WS_RECONNECT_MS);
  };
}

function disconnectWebSocket(clearWanted = true) {
  if (clearWanted) wsWanted = false;
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  if (ws) {
    const socket = ws;
    ws = null;
    socket.onclose = null;
    socket.close();
  }
}

function clearAllTrails() {
  for (const agent of agents.values()) {
    agent.clearTrail();
  }
}

function disposeAllAgents() {
  for (const agent of agents.values()) {
    agent.dispose();
  }
  agents.clear();
}

async function startDetection() {
  hideError();
  try {
    if (!sceneReady) initScene();
    placeholder.hidden = true;

    if (!modelReady) {
      detectBadge.textContent = "加载模型…";
      await loadHumanModel();
    }

    const res = await fetch("/api/detect/start", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "启动失败");

    startBtn.disabled = true;
    stopBtn.disabled = false;
    detectBadge.textContent = "连接中…";
    detectBadge.className = "badge ok";
    videoPip.src = `/api/detect/stream?t=${Date.now()}`;
    videoPipWrap.hidden = false;
    videoPipWrap.classList.remove("expanded");
    connectWebSocket();
    resetCamera();
  } catch (e) {
    showError(e.message || String(e));
    detectBadge.textContent = "错误";
    detectBadge.className = "badge";
  }
}

async function stopDetection() {
  disconnectWebSocket(true);
  await fetch("/api/detect/stop", { method: "POST" });
  videoPip.src = "";
  videoPipWrap.hidden = true;
  videoPipWrap.classList.remove("expanded");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  detectBadge.textContent = "已停止";
  detectBadge.className = "badge";
  fpsBadge.textContent = "FPS: -";
  disposeAllAgents();
  personList.innerHTML = '<li class="point-item" style="color:var(--text-muted)">暂无检测</li>';
}

function toggleVideoPipSize(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  if (!videoPipWrap || videoPipWrap.hidden) return;
  const expanded = videoPipWrap.classList.toggle("expanded");
  if (videoPipToggle) {
    videoPipToggle.textContent = expanded ? "⤡" : "⤢";
    videoPipToggle.title = expanded ? "缩小" : "放大";
  }
}

startBtn.addEventListener("click", startDetection);
stopBtn.addEventListener("click", stopDetection);
resetCamBtn.addEventListener("click", resetCamera);
clearTrailBtn.addEventListener("click", clearAllTrails);
videoPipWrap?.addEventListener("click", toggleVideoPipSize);
videoPipToggle?.addEventListener("click", toggleVideoPipSize);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && videoPipWrap?.classList.contains("expanded")) {
    videoPipWrap.classList.remove("expanded");
    if (videoPipToggle) {
      videoPipToggle.textContent = "⤢";
      videoPipToggle.title = "放大";
    }
  }
});
