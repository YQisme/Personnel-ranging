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
const MODEL_URL = "/static/models/Soldier.glb";
const MODEL_SCALE = 1.0;
const MODEL_Y_OFFSET = 0;
const WS_RECONNECT_MS = 1500;

/** 小于此位移（米）视为检测噪声，不更新目标点 */
const POS_DEADZONE = 0.45;
/** 走到目标附近视为到达 */
const ARRIVE_EPS = 0.2;
/** 低于此速度（m/s）视为静止 */
const IDLE_SPEED = 0.4;
const RUN_SPEED = 2.2;
/** 走路动画对应的标称步速（米/秒），用于匹配步频 */
const WALK_PACE = 1.25;

/**
 * 人员落点用摄像头地面坐标系直角坐标，不用极径距离 D。
 *   camX = ground_x  横向（左负右正）
 *   camY = ground_y  纵深（沿主视野，米）
 * Three.js：水平面 (worldX, worldZ) = (sign*camX, camY)，竖直为 worldY。
 */
function toWorldPos(camX, camY, out) {
  const sign = mirrorX?.checked ? -1 : 1;
  out.set(sign * camX, 0, camY);
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
const mirrorX = document.getElementById("mirrorX");
const videoPip = document.getElementById("videoPip");
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

    this.model = cloneSkinned(template);
    this.model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (obj.material) {
          obj.material = obj.material.clone();
        }
      }
    });
    this.model.scale.setScalar(MODEL_SCALE);
    this.model.position.y = MODEL_Y_OFFSET;
    this.group.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of animations) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      this.actions[clip.name] = action;
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

    this.trailGeom = new THREE.BufferGeometry();
    this.trailMat = new THREE.LineBasicMaterial({
      color: DIR_COLORS.unknown,
      transparent: true,
      opacity: 0.85,
    });
    this.trailLine = new THREE.Line(this.trailGeom, this.trailMat);
    this.trailLine.frustumCulled = false;

    const labelEl = document.createElement("div");
    labelEl.className = "person-label unknown";
    labelEl.textContent = `#${personId}`;
    this.label = new CSS2DObject(labelEl);
    this.label.position.set(0, 1.9, 0);
    this.group.add(this.label);

    scene.add(this.group);
    scene.add(this.trailLine);
  }

  _play(name) {
    const next = this.actions[name] || this.actions.Idle;
    if (!next || this.currentAction === next) return;
    if (this.currentAction) {
      this.currentAction.fadeOut(0.25);
    }
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.25).play();
    this.currentAction = next;
  }

  updateFromApi(p) {
    this.camX = p.ground_x;
    this.camY = p.ground_y;
    toWorldPos(this.camX, this.camY, this._rawTarget);
    this.speed = p.speed || 0;
    this.direction = p.direction || "unknown";
    this.distance = p.distance || 0;
    this.lastSeen = performance.now();

    // 死区：噪声引起的原地抖动不改目标；真正走出一段距离才更新
    const jump = this._rawTarget.distanceTo(this.target);
    const apiMoving =
      this.speed >= IDLE_SPEED && this.direction !== "stationary";
    if (jump >= POS_DEADZONE || (apiMoving && jump >= ARRIVE_EPS)) {
      this.target.copy(this._rawTarget);
    }

    const color = DIR_COLORS[this.direction] ?? DIR_COLORS.unknown;
    this.trailMat.color.setHex(color);

    const el = this.label.element;
    el.className = `person-label ${this.direction}`;
    el.textContent = `#${this.personId}  x:${this.camX.toFixed(1)}  y:${this.camY.toFixed(1)}`;
  }

  tick(dt) {
    const offsetX = this.target.x - this.smooth.x;
    const offsetZ = this.target.z - this.smooth.z;
    const dist = Math.hypot(offsetX, offsetZ);
    const apiMoving =
      this.speed >= IDLE_SPEED && this.direction !== "stationary";

    // 已到达且检测判定静止 → 站住播 Idle，避免原地踏步
    if (dist < ARRIVE_EPS && !apiMoving) {
      this._moving = false;
      this.displaySpeed = 0;
      this._play("Idle");
      this.mixer.update(dt);
      this.group.position.copy(this.smooth);
      return;
    }

    if (dist >= ARRIVE_EPS) {
      this.heading = Math.atan2(offsetX, offsetZ);

      // 按真实位移走路：速度取检测速度，过小则用步行速度追上目标
      let v = this.speed;
      if (v < IDLE_SPEED) {
        v = Math.min(WALK_PACE, dist * 2);
      }
      v = THREE.MathUtils.clamp(v, 0.5, 4.5);

      const step = Math.min(dist, v * dt);
      const inv = 1 / dist;
      this.smooth.x += offsetX * inv * step;
      this.smooth.z += offsetZ * inv * step;
      this.displaySpeed = v;
      this._moving = true;
    } else {
      this.displaySpeed = this.speed;
      this._moving = apiMoving;
    }

    const curY = this.group.rotation.y;
    let diff = this.heading - curY;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.group.rotation.y = curY + diff * Math.min(1, 8 * dt);

    this.group.position.copy(this.smooth);

    if (!this._moving || this.displaySpeed < IDLE_SPEED) {
      this._play("Idle");
    } else if (this.displaySpeed >= RUN_SPEED) {
      this._play("Run");
      if (this.currentAction) {
        this.currentAction.setEffectiveTimeScale(
          THREE.MathUtils.clamp(this.displaySpeed / 3.5, 0.8, 1.6),
        );
      }
    } else {
      this._play("Walk");
      if (this.currentAction) {
        // 步频与地面位移速度对齐，避免“腿在走、人在原地晃”
        this.currentAction.setEffectiveTimeScale(
          THREE.MathUtils.clamp(this.displaySpeed / WALK_PACE, 0.7, 1.6),
        );
      }
    }

    this.mixer.update(dt);

    if (this._moving) {
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
  // 站在摄像头后方稍高处，沿主视野看向场景深处（与监控画面同向）
  camera.position.set(0, 8, -6);
  controls.target.set(0, 0, 12);
  controls.update();
}

function buildCctvCamera() {
  const group = new THREE.Group();
  group.name = "cctv";

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 3.2, 10),
    new THREE.MeshStandardMaterial({ color: 0x4b5563 }),
  );
  pole.position.y = 1.6;
  group.add(pole);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.35, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.25 }),
  );
  head.position.set(0, 3.2, 0.15);
  group.add(head);

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.14, 0.2, 16),
    new THREE.MeshStandardMaterial({ color: 0x111827 }),
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 3.2, 0.55);
  group.add(lens);

  // 视野锥：沿 +Z（标定 ground_y / 距摄像头方向）
  const fov = 50 * (Math.PI / 180);
  const aspect = 16 / 9;
  const nearH = 0.4;
  const farDist = 18;
  const nearW = nearH * aspect;
  const farH = 2 * Math.tan(fov / 2) * farDist;
  const farW = farH * aspect;
  const origin = new THREE.Vector3(0, 3.2, 0.55);

  const corners = [
    new THREE.Vector3(-farW / 2, 3.2 + farH / 2, farDist),
    new THREE.Vector3(farW / 2, 3.2 + farH / 2, farDist),
    new THREE.Vector3(farW / 2, 3.2 - farH / 2, farDist),
    new THREE.Vector3(-farW / 2, 3.2 - farH / 2, farDist),
  ];
  const fringe = [];
  for (const c of corners) {
    fringe.push(origin, c);
  }
  fringe.push(corners[0], corners[1], corners[1], corners[2], corners[2], corners[3], corners[3], corners[0]);
  const fringeGeom = new THREE.BufferGeometry().setFromPoints(fringe);
  const fringeLine = new THREE.LineSegments(
    fringeGeom,
    new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.55 }),
  );
  group.add(fringeLine);

  const labelEl = document.createElement("div");
  labelEl.className = "person-label";
  labelEl.style.borderColor = "rgba(245, 158, 11, 0.8)";
  labelEl.style.color = "#fbbf24";
  labelEl.textContent = "摄像头 O";
  const label = new CSS2DObject(labelEl);
  label.position.set(0, 3.8, 0);
  group.add(label);

  scene.add(group);
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

  // 摄像头地面直角坐标轴：X 横向、Y 纵深（映射到 Three +Z）
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

  makeAxisLabel("cam X →", "#60a5fa", 8, 0.08, 0.5);
  makeAxisLabel("← cam X", "#60a5fa", -8, 0.08, 0.5);
  makeAxisLabel("cam Y →", "#fbbf24", 0.8, 0.08, 12);

  // 纵深刻度（摄像头相对 Y，不是极径 D）
  for (const y of [5, 10, 15, 20, 30]) {
    makeAxisLabel(`y=${y}m`, "#8b9cb3", 1.2, 0.06, y);
    const tick = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.02, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.7 }),
    );
    tick.position.set(0, 0.03, y);
    scene.add(tick);
  }

  // 横向刻度
  for (const x of [-10, -5, 5, 10]) {
    makeAxisLabel(`x=${x}`, "#8b9cb3", x, 0.06, 1.5);
    const tick = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.02, 1.2),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.7 }),
    );
    tick.position.set(x, 0.03, 0);
    scene.add(tick);
  }

  buildCctvCamera();

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
  viewport.appendChild(labelRenderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 12);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2;
  controls.maxDistance = 80;
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

  for (const agent of agents.values()) {
    agent.tick(dt);
  }

  if (followCam.checked && agents.size > 0) {
    let nearest = null;
    let best = Infinity;
    for (const a of agents.values()) {
      if (a.distance < best) {
        best = a.distance;
        nearest = a;
      }
    }
    if (nearest) {
      // 保持从摄像头方向观察：目标点跟随人员，相机在其后方
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
    if (!agent) {
      if (!modelReady) continue;
      agent = new PersonAgent(p.person_id, templateModel, templateAnimations);
      toWorldPos(p.ground_x, p.ground_y, agent.smooth);
      agent.target.copy(agent.smooth);
      agent._rawTarget.copy(agent.smooth);
      agents.set(p.person_id, agent);
    }
    agent.updateFromApi(p);
  }

  const now = performance.now();
  for (const [id, agent] of agents) {
    if (!liveIds.has(id) && now - agent.lastSeen > 3000) {
      agent.dispose();
      agents.delete(id);
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
        摄像头坐标 <strong>x=${p.ground_x}</strong>, <strong>y=${p.ground_y}</strong> m<br>
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
    videoPip.hidden = false;
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
  videoPip.hidden = true;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  detectBadge.textContent = "已停止";
  detectBadge.className = "badge";
  fpsBadge.textContent = "FPS: -";
  disposeAllAgents();
  personList.innerHTML = '<li class="point-item" style="color:var(--text-muted)">暂无检测</li>';
}

startBtn.addEventListener("click", startDetection);
stopBtn.addEventListener("click", stopDetection);
resetCamBtn.addEventListener("click", resetCamera);
clearTrailBtn.addEventListener("click", clearAllTrails);
mirrorX?.addEventListener("change", () => {
  // 镜像切换后清空轨迹，避免旧路径错位
  clearAllTrails();
});
