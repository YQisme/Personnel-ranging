"""Web 服务 — 标定 + 实时检测预览"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import asyncio
from contextlib import asynccontextmanager

import cv2
import numpy as np
import uvicorn
import yaml
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src.calibration_service import (
    capture_frame,
    encode_frame_jpeg,
    get_label,
    resolve_homography_path,
    resolve_video_source,
    save_calibration,
    validate_calibration,
)
from src.live_detection import LiveDetectionService

STATIC_DIR = Path(__file__).resolve().parent / "static"
CONFIG_PATH = ROOT / "config" / "config.yaml"

_current_frame: np.ndarray | None = None
_detection_service: LiveDetectionService | None = None


def _shutdown_detection():
    global _detection_service
    if _detection_service is not None:
        try:
            _detection_service.stop()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    # CTRL+C / 进程退出时先停检测，打断 MJPEG / WebSocket 长连接
    await asyncio.to_thread(_shutdown_detection)


app = FastAPI(title="YOLO 人员距离速度检测", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

class CalibrateRequest(BaseModel):
    points: list[dict] = Field(..., min_length=4)


def _get_detection_service() -> LiveDetectionService:
    global _detection_service
    if _detection_service is None:
        _detection_service = LiveDetectionService(str(CONFIG_PATH))
    return _detection_service


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/monitor", response_class=HTMLResponse)
async def monitor():
    return HTMLResponse((STATIC_DIR / "monitor.html").read_text(encoding="utf-8"))


@app.get("/trajectory", response_class=HTMLResponse)
async def trajectory():
    return HTMLResponse((STATIC_DIR / "trajectory.html").read_text(encoding="utf-8"))


@app.get("/api/status")
async def status():
    homography_path = resolve_homography_path(str(CONFIG_PATH))
    calibrated = Path(homography_path).exists()
    source = resolve_video_source(str(CONFIG_PATH))
    has_frame = _current_frame is not None
    frame_size = None
    if _current_frame is not None:
        h, w = _current_frame.shape[:2]
        frame_size = {"width": w, "height": h}
    det = _detection_service
    detect_running = det is not None and det.running
    return {
        "video_source": source,
        "homography_file": homography_path,
        "calibrated": calibrated,
        "has_frame": has_frame,
        "frame_size": frame_size,
        "detect_running": detect_running,
    }


@app.post("/api/capture")
async def api_capture(source: str | None = None):
    global _current_frame
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            config = yaml.safe_load(f)
        config["_config_path"] = str(CONFIG_PATH.resolve())
        video_source = resolve_video_source(str(CONFIG_PATH), source)
        _current_frame = capture_frame(video_source, config)
        h, w = _current_frame.shape[:2]
        return {"ok": True, "source": video_source, "width": w, "height": h}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)):
    global _current_frame
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="请上传图片文件")
    data = await file.read()
    arr = np.frombuffer(data, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=400, detail="无法解析图片")
    _current_frame = frame
    h, w = frame.shape[:2]
    return {"ok": True, "width": w, "height": h}


@app.get("/api/frame")
async def api_frame():
    if _current_frame is None:
        raise HTTPException(status_code=404, detail="请先抓拍或上传图片")
    return Response(content=encode_frame_jpeg(_current_frame), media_type="image/jpeg")


@app.get("/api/existing")
async def api_existing():
    homography_path = Path(resolve_homography_path(str(CONFIG_PATH)))
    json_path = homography_path.with_suffix(".json")
    if not json_path.exists():
        return {"points": []}
    import json
    with open(json_path, encoding="utf-8") as f:
        meta = json.load(f)
    points = []
    pixel_pts = meta.get("pixel_points", [])
    ground_pts = meta.get("ground_points", [])
    non_origin_idx = 0
    for i, (px, py) in enumerate(pixel_pts):
        gx, gy = ground_pts[i]
        is_origin = abs(gx) < 1e-6 and abs(gy) < 1e-6
        if is_origin:
            label = "O"
        else:
            label = get_label(non_origin_idx)
            non_origin_idx += 1
        points.append({
            "label": label,
            "is_origin": is_origin,
            "pixel_x": px,
            "pixel_y": py,
            "ground_x": gx,
            "ground_y": gy,
        })
    return {"points": points}


@app.post("/api/validate")
async def api_validate(req: CalibrateRequest):
    try:
        pixel_points = [[p["pixel_x"], p["pixel_y"]] for p in req.points]
        ground_points = [[p["ground_x"], p["ground_y"]] for p in req.points]
        labels = [str(p.get("label", get_label(i))) for i, p in enumerate(req.points)]
        return validate_calibration(pixel_points, ground_points, labels=labels)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/save")
async def api_save(req: CalibrateRequest):
    try:
        pixel_points = [[p["pixel_x"], p["pixel_y"]] for p in req.points]
        ground_points = [[p["ground_x"], p["ground_y"]] for p in req.points]
        labels = [str(p.get("label", get_label(i))) for i, p in enumerate(req.points)]
        output = resolve_homography_path(str(CONFIG_PATH))
        return save_calibration(pixel_points, ground_points, output, labels=labels)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/detect/start")
async def detect_start():
    homography_path = resolve_homography_path(str(CONFIG_PATH))
    if not Path(homography_path).exists():
        raise HTTPException(status_code=400, detail="请先完成标定")
    svc = _get_detection_service()
    if not svc.running:
        try:
            svc.start()
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    return svc.get_status()


@app.post("/api/detect/stop")
async def detect_stop():
    global _detection_service
    if _detection_service and _detection_service.running:
        _detection_service.stop()
    return {"running": False}


@app.get("/api/detect/status")
async def detect_status():
    if _detection_service is None:
        return {"running": False, "fps": 0, "persons": [], "error": None}
    return _detection_service.get_status()


@app.get("/api/detect/stream")
async def detect_stream():
    homography_path = resolve_homography_path(str(CONFIG_PATH))
    if not Path(homography_path).exists():
        raise HTTPException(status_code=400, detail="请先完成标定")

    svc = _get_detection_service()
    if not svc.running:
        try:
            svc.start()
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    return StreamingResponse(
        svc.mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.websocket("/ws/detect")
async def ws_detect(websocket: WebSocket):
    """检测结果实时推送：有新帧发 type=status，否则短轮询（便于关停取消）。"""
    await websocket.accept()
    svc = _get_detection_service()
    last_seq = -1
    try:
        snap = svc.get_status()
        last_seq = snap["seq"]
        await websocket.send_json({"type": "status", **snap})

        while True:
            # 非阻塞短等，避免 to_thread + Condition 在 CTRL+C 时拖死关停
            await asyncio.sleep(0.05)
            status = svc.get_status()
            seq = status["seq"]
            if seq == last_seq:
                continue
            last_seq = seq
            await websocket.send_json({"type": "status", **status})
    except (WebSocketDisconnect, asyncio.CancelledError):
        return


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Web 标定与实时检测")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    print(f"标定页面:   http://{args.host}:{args.port}/")
    print(f"实时监控:   http://{args.host}:{args.port}/monitor")
    print(f"3D 轨迹:    http://{args.host}:{args.port}/trajectory")
    print(f"WebSocket:  ws://{args.host}:{args.port}/ws/detect")
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()
