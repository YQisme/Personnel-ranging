const DIRECTION_LABELS = {
  approaching: "靠近摄像头",
  retreating: "远离摄像头",
  stationary: "静止",
  unknown: "未知",
};

const liveStream = document.getElementById("liveStream");
const streamPlaceholder = document.getElementById("streamPlaceholder");
const personList = document.getElementById("personList");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const fpsBadge = document.getElementById("fpsBadge");
const detectBadge = document.getElementById("detectBadge");
const messageBox = document.getElementById("messageBox");

let pollTimer = null;

function showError(msg) {
  messageBox.textContent = msg;
  messageBox.hidden = false;
}

function hideError() {
  messageBox.hidden = true;
}

async function startDetection() {
  hideError();
  try {
    const res = await fetch("/api/detect/start", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "启动失败");

    liveStream.src = `/api/detect/stream?t=${Date.now()}`;
    liveStream.hidden = false;
    streamPlaceholder.hidden = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    detectBadge.textContent = "运行中";
    detectBadge.className = "badge ok";
    startPolling();
  } catch (e) {
    showError(e.message);
  }
}

async function stopDetection() {
  await fetch("/api/detect/stop", { method: "POST" });
  liveStream.src = "";
  liveStream.hidden = true;
  streamPlaceholder.hidden = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  detectBadge.textContent = "已停止";
  detectBadge.className = "badge";
  fpsBadge.textContent = "FPS: -";
  stopPolling();
  personList.innerHTML = '<li class="point-item" style="color:var(--text-muted)">暂无检测</li>';
}

function renderPersons(persons) {
  if (!persons.length) {
    personList.innerHTML = '<li class="point-item" style="color:var(--text-muted)">暂无人员</li>';
    return;
  }

  personList.innerHTML = "";
  persons.forEach((p) => {
    const li = document.createElement("li");
    li.className = "point-item";
    const dir = DIRECTION_LABELS[p.direction] || p.direction;

    li.innerHTML = `
      <span class="label">#${p.person_id}</span>
      <span class="meta">
        相对原点 <strong>x=${p.ground_x}m</strong>, <strong>y=${p.ground_y}m</strong><br>
        速度 ${p.speed} m/s (${p.speed_kmh} km/h)<br>
        ${dir}
      </span>
    `;
    personList.appendChild(li);
  });
}

async function pollStatus() {
  try {
    const res = await fetch("/api/detect/status");
    const data = await res.json();
    if (data.running) {
      fpsBadge.textContent = `FPS: ${data.fps}`;
      renderPersons(data.persons || []);
      if (data.error) showError(data.error);
      else hideError();
    }
  } catch {
    // 忽略轮询错误
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollStatus, 500);
  pollStatus();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

startBtn.addEventListener("click", startDetection);
stopBtn.addEventListener("click", stopDetection);

liveStream.addEventListener("error", () => {
  if (stopBtn.disabled) return;
  showError("视频流断开，请检查视频源或重新启动");
});
