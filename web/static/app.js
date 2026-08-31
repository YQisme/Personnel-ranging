const POINT_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

const state = {
  points: [],
  image: null,
  imageWidth: 0,
  imageHeight: 0,
  pendingClick: null,
};

const canvas = document.getElementById("calibCanvas");
const ctx = canvas.getContext("2d");
const pointList = document.getElementById("pointList");
const statusBadge = document.getElementById("statusBadge");
const messageBox = document.getElementById("messageBox");
const verifyBox = document.getElementById("verifyBox");
const canvasWrap = document.getElementById("canvasWrap");
const placeholder = document.getElementById("placeholder");
const modal = document.getElementById("pointModal");
const distanceInput = document.getElementById("distanceInput");
const lateralInput = document.getElementById("lateralInput");
const modalTitle = document.getElementById("modalTitle");
const modalPixel = document.getElementById("modalPixel");

function getLabel(i) {
  return i < POINT_LABELS.length ? POINT_LABELS[i] : `P${i + 1}`;
}

function showMessage(text, type = "success") {
  messageBox.className = `alert alert-${type}`;
  messageBox.textContent = text;
  messageBox.hidden = false;
}

function hideMessage() {
  messageBox.hidden = true;
}

async function fetchStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  statusBadge.textContent = data.calibrated ? "已标定" : "未标定";
  statusBadge.className = data.calibrated ? "badge ok" : "badge";
  document.getElementById("videoSource").textContent = data.video_source || "-";
  return data;
}

async function captureFrame() {
  hideMessage();
  try {
    const res = await fetch("/api/capture", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "抓拍失败");
    await loadFrame();
    showMessage(`已从视频源抓拍 ${data.width}×${data.height}`, "success");
  } catch (e) {
    showMessage(e.message, "error");
  }
}

async function loadFrame() {
  const res = await fetch("/api/frame");
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "无画面");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imageWidth = img.naturalWidth;
    state.imageHeight = img.naturalHeight;
    canvas.hidden = false;
    placeholder.hidden = true;
    canvasWrap.classList.remove("empty");
    resizeCanvas();
    draw();
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function resizeCanvas() {
  if (!state.image) return;
  const maxW = canvasWrap.clientWidth - 2;
  const maxH = window.innerHeight - 200;
  const scale = Math.min(maxW / state.imageWidth, maxH / state.imageHeight, 1);
  canvas.width = state.imageWidth * scale;
  canvas.height = state.imageHeight * scale;
  draw();
}

function canvasToImage(x, y) {
  const scaleX = state.imageWidth / canvas.width;
  const scaleY = state.imageHeight / canvas.height;
  return { x: x * scaleX, y: y * scaleY };
}

function imageToCanvas(x, y) {
  const scaleX = canvas.width / state.imageWidth;
  const scaleY = canvas.height / state.imageHeight;
  return { x: x * scaleX, y: y * scaleY };
}

function draw() {
  if (!state.image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);

  if (state.points.length >= 2) {
    ctx.beginPath();
    const first = imageToCanvas(state.points[0].pixel_x, state.points[0].pixel_y);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < state.points.length; i++) {
      const p = imageToCanvas(state.points[i].pixel_x, state.points[i].pixel_y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = "#06b6d4";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  state.points.forEach((pt) => {
    const { x, y } = imageToCanvas(pt.pixel_x, pt.pixel_y);
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#22c55e";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText(`${pt.label} ${pt.distance}m`, x + 10, y - 8);
  });
}

function renderPointList() {
  pointList.innerHTML = "";
  state.points.forEach((pt, i) => {
    const li = document.createElement("li");
    li.className = "point-item";
    li.innerHTML = `
      <span class="label">${pt.label}</span>
      <span class="meta">
        像素 (${pt.pixel_x.toFixed(0)}, ${pt.pixel_y.toFixed(0)})<br>
        距 O ${pt.distance}m，横向 ${pt.lateral}m
      </span>
      <button type="button" data-index="${i}">删除</button>
    `;
    pointList.appendChild(li);
  });

  pointList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index, 10);
      state.points.splice(idx, 1);
      state.points.forEach((p, j) => { p.label = getLabel(j); });
      renderPointList();
      draw();
      verifyBox.hidden = true;
    });
  });

  document.getElementById("saveBtn").disabled = state.points.length < 4;
  document.getElementById("validateBtn").disabled = state.points.length < 4;
}

function openModal(pixelX, pixelY) {
  const idx = state.points.length;
  modalTitle.textContent = `标定点 ${getLabel(idx)}`;
  modalPixel.textContent = `像素坐标: (${pixelX.toFixed(0)}, ${pixelY.toFixed(0)})`;
  distanceInput.value = "";
  lateralInput.value = "0";
  state.pendingClick = { pixel_x: pixelX, pixel_y: pixelY };
  modal.classList.remove("hidden");
  distanceInput.focus();
}

function closeModal() {
  modal.classList.add("hidden");
  state.pendingClick = null;
}

function confirmModal() {
  if (!state.pendingClick) return;
  const distance = parseFloat(distanceInput.value);
  const lateral = parseFloat(lateralInput.value) || 0;
  if (isNaN(distance) || distance <= 0) {
    showMessage("请输入有效的距 O 距离（米）", "error");
    return;
  }
  const idx = state.points.length;
  state.points.push({
    label: getLabel(idx),
    pixel_x: state.pendingClick.pixel_x,
    pixel_y: state.pendingClick.pixel_y,
    ground_x: lateral,
    ground_y: distance,
    distance: distance,
    lateral: lateral,
  });
  closeModal();
  renderPointList();
  draw();
  verifyBox.hidden = true;
}

canvas.addEventListener("click", (e) => {
  if (!state.image) return;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const { x, y } = canvasToImage(cx, cy);
  openModal(x, y);
});

document.getElementById("captureBtn").addEventListener("click", captureFrame);
document.getElementById("uploadBtn").addEventListener("click", () => {
  document.getElementById("uploadInput").click();
});

document.getElementById("uploadInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "上传失败");
    await loadFrame();
    showMessage(`图片已加载 ${data.width}×${data.height}`, "success");
  } catch (err) {
    showMessage(err.message, "error");
  }
  e.target.value = "";
});

document.getElementById("resetBtn").addEventListener("click", () => {
  state.points = [];
  renderPointList();
  draw();
  verifyBox.hidden = true;
  hideMessage();
});

document.getElementById("importBtn").addEventListener("click", loadExisting);

document.getElementById("modalConfirm").addEventListener("click", confirmModal);
document.getElementById("modalCancel").addEventListener("click", closeModal);

document.getElementById("validateBtn").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: state.points }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "验证失败");
    showVerifyResult(data);
    if (data.collinear_warning) {
      showMessage("标定点几乎共线，建议增加左右横向偏移点", "warning");
    } else {
      showMessage("验证通过，可以保存", "success");
    }
  } catch (e) {
    showMessage(e.message, "error");
  }
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: state.points }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "保存失败");
    showVerifyResult(data);
    await fetchStatus();
    showMessage(`标定已保存至 ${data.saved_to}`, "success");
  } catch (e) {
    showMessage(e.message, "error");
  }
});

function showVerifyResult(data) {
  verifyBox.hidden = false;
  let html = "";
  if (data.collinear_warning) {
    html += `<div class="alert alert-warning">标定点几乎共线，建议在同一距离增加左右横向点</div>`;
  }
  html += `<table class="verify-table">
    <thead><tr><th>点</th><th>地面坐标</th><th>距 O</th><th>误差</th></tr></thead><tbody>`;
  data.verification.forEach((v) => {
    html += `<tr>
      <td>${v.label}</td>
      <td>(${v.ground[0]}, ${v.ground[1]})m</td>
      <td>${v.distance_from_o}m</td>
      <td>${v.error_m}m</td>
    </tr>`;
  });
  html += "</tbody></table>";
  verifyBox.innerHTML = html;
}

async function loadExisting() {
  const res = await fetch("/api/existing");
  const data = await res.json();
  if (!data.points?.length) return;
  state.points = data.points.map((p, i) => ({
    ...p,
    label: getLabel(i),
  }));
  renderPointList();
  draw();
  showMessage(`已导入 ${state.points.length} 个标定点（旧版 O 点已自动忽略）`, "success");
}

window.addEventListener("resize", resizeCanvas);

(async () => {
  await fetchStatus();
  try {
    await loadFrame();
  } catch {
    // 无帧时等待用户抓拍或上传
  }
})();
