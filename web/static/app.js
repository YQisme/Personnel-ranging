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
const groundXInput = document.getElementById("groundXInput");
const groundYInput = document.getElementById("groundYInput");
const modalTitle = document.getElementById("modalTitle");
const modalPixel = document.getElementById("modalPixel");

function hasOrigin() {
  return state.points.some((p) => p.is_origin);
}

function relabelPoints() {
  let nonOriginIdx = 0;
  state.points.forEach((p) => {
    if (p.is_origin) {
      p.label = "O";
      p.ground_x = 0;
      p.ground_y = 0;
    } else {
      p.label = nonOriginIdx < POINT_LABELS.length
        ? POINT_LABELS[nonOriginIdx]
        : `P${nonOriginIdx + 1}`;
      nonOriginIdx += 1;
    }
  });
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

function formatXY(gx, gy) {
  return `(${Number(gx).toFixed(1)}, ${Number(gy).toFixed(1)})m`;
}

function draw() {
  if (!state.image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);

  // 从原点连线到各标定点
  const origin = state.points.find((p) => p.is_origin);
  if (origin && state.points.length >= 2) {
    const o = imageToCanvas(origin.pixel_x, origin.pixel_y);
    state.points.forEach((pt) => {
      if (pt.is_origin) return;
      const p = imageToCanvas(pt.pixel_x, pt.pixel_y);
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = "rgba(6, 182, 212, 0.7)";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  state.points.forEach((pt) => {
    const { x, y } = imageToCanvas(pt.pixel_x, pt.pixel_y);
    const fill = pt.is_origin ? "#f97316" : "#22c55e";
    ctx.beginPath();
    ctx.arc(x, y, pt.is_origin ? 9 : 7, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#fff";
    const text = pt.is_origin
      ? "O (0, 0)"
      : `${pt.label} ${formatXY(pt.ground_x, pt.ground_y)}`;
    ctx.fillText(text, x + 10, y - 8);
  });
}

function renderPointList() {
  pointList.innerHTML = "";
  state.points.forEach((pt, i) => {
    const li = document.createElement("li");
    li.className = "point-item";
    const meta = pt.is_origin
      ? `像素 (${pt.pixel_x.toFixed(0)}, ${pt.pixel_y.toFixed(0)})<br>原点 (0, 0)m`
      : `像素 (${pt.pixel_x.toFixed(0)}, ${pt.pixel_y.toFixed(0)})<br>相对 O：x=${pt.ground_x}m，y=${pt.ground_y}m`;
    li.innerHTML = `
      <span class="label"${pt.is_origin ? ' style="color:#f97316"' : ""}>${pt.label}</span>
      <span class="meta">${meta}</span>
      <button type="button" data-index="${i}">删除</button>
    `;
    pointList.appendChild(li);
  });

  pointList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index, 10);
      const removed = state.points[idx];
      if (removed?.is_origin) {
        state.points = [];
        showMessage("已删除原点，请重新点击画面指定原点", "warning");
      } else {
        state.points.splice(idx, 1);
        relabelPoints();
      }
      renderPointList();
      draw();
      verifyBox.hidden = true;
    });
  });

  const ready = state.points.length >= 4 && hasOrigin();
  document.getElementById("saveBtn").disabled = !ready;
  document.getElementById("validateBtn").disabled = !ready;
}

function openModal(pixelX, pixelY) {
  const nonOriginCount = state.points.filter((p) => !p.is_origin).length;
  const label = nonOriginCount < POINT_LABELS.length
    ? POINT_LABELS[nonOriginCount]
    : `P${nonOriginCount + 1}`;
  modalTitle.textContent = `标定点 ${label}`;
  modalPixel.textContent = `像素坐标: (${pixelX.toFixed(0)}, ${pixelY.toFixed(0)}) · 相对原点的地面坐标`;
  groundXInput.value = "";
  groundYInput.value = "";
  state.pendingClick = { pixel_x: pixelX, pixel_y: pixelY };
  modal.classList.remove("hidden");
  groundXInput.focus();
}

function closeModal() {
  modal.classList.add("hidden");
  state.pendingClick = null;
}

function confirmModal() {
  if (!state.pendingClick) return;
  const gx = parseFloat(groundXInput.value);
  const gy = parseFloat(groundYInput.value);
  if (isNaN(gx) || isNaN(gy)) {
    showMessage("请输入有效的 x、y 坐标（米）", "error");
    return;
  }
  if (Math.abs(gx) < 1e-9 && Math.abs(gy) < 1e-9) {
    showMessage("非原点请勿填 (0, 0)，请点击画面重新指定原点", "error");
    return;
  }
  const nonOriginCount = state.points.filter((p) => !p.is_origin).length;
  const label = nonOriginCount < POINT_LABELS.length
    ? POINT_LABELS[nonOriginCount]
    : `P${nonOriginCount + 1}`;
  state.points.push({
    label,
    is_origin: false,
    pixel_x: state.pendingClick.pixel_x,
    pixel_y: state.pendingClick.pixel_y,
    ground_x: gx,
    ground_y: gy,
  });
  closeModal();
  renderPointList();
  draw();
  verifyBox.hidden = true;
}

function addOrigin(pixelX, pixelY) {
  state.points.unshift({
    label: "O",
    is_origin: true,
    pixel_x: pixelX,
    pixel_y: pixelY,
    ground_x: 0,
    ground_y: 0,
  });
  showMessage("已设定原点 O (0, 0)，继续点击添加标定点并输入 (x, y)", "success");
  renderPointList();
  draw();
}

canvas.addEventListener("click", (e) => {
  if (!state.image) return;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const { x, y } = canvasToImage(cx, cy);
  if (!hasOrigin()) {
    addOrigin(x, y);
  } else {
    openModal(x, y);
  }
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
      showMessage("标定点几乎共线，建议增加分散的横向/纵向点", "warning");
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
    html += `<div class="alert alert-warning">标定点几乎共线，建议增加分散的横向/纵向点</div>`;
  }
  html += `<table class="verify-table">
    <thead><tr><th>点</th><th>期望 (x,y)</th><th>拟合 (x,y)</th><th>误差</th></tr></thead><tbody>`;
  data.verification.forEach((v) => {
    html += `<tr>
      <td>${v.label}</td>
      <td>(${v.expected_ground[0]}, ${v.expected_ground[1]})m</td>
      <td>(${v.ground[0]}, ${v.ground[1]})m</td>
      <td>${v.error_m}m</td>
    </tr>`;
  });
  html += "</tbody></table>";
  verifyBox.innerHTML = html;
}

async function loadExisting() {
  const res = await fetch("/api/existing");
  const data = await res.json();
  if (!data.points?.length) {
    showMessage("没有已保存的标定点", "warning");
    return;
  }
  state.points = data.points.map((p) => {
    const isOrigin = Boolean(p.is_origin) ||
      (Math.abs(p.ground_x) < 1e-6 && Math.abs(p.ground_y) < 1e-6);
    return {
      label: isOrigin ? "O" : p.label,
      is_origin: isOrigin,
      pixel_x: p.pixel_x,
      pixel_y: p.pixel_y,
      ground_x: isOrigin ? 0 : p.ground_x,
      ground_y: isOrigin ? 0 : p.ground_y,
    };
  });
  // 若旧标定无原点，提示用户补点
  if (!hasOrigin()) {
    showMessage(
      `已导入 ${state.points.length} 个点，但缺少原点。请先点击画面指定原点 O`,
      "warning",
    );
  } else {
    relabelPoints();
    showMessage(`已导入 ${state.points.length} 个标定点`, "success");
  }
  renderPointList();
  draw();
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
