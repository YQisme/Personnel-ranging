"""Web 实时检测服务 — 后台线程读帧 + MJPEG 输出"""

import threading
import time

from src.calibration_service import encode_frame_jpeg
from src.pipeline import DetectionPipeline
from src.video_source import VideoSource


class LiveDetectionService:
    def __init__(self, config_path: str):
        self.config_path = config_path
        self.pipeline: DetectionPipeline | None = None
        self.video: VideoSource | None = None
        self.running = False
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._latest_jpeg: bytes | None = None
        self._latest_events: list = []
        self._fps: float = 0.0
        self._error: str | None = None

    def start(self):
        if self.running:
            return
        try:
            self.pipeline = DetectionPipeline(self.config_path)
            self.video = VideoSource(self.pipeline.config)
            if not self.video.open():
                raise RuntimeError(f"无法打开视频源: {self.video.source}")
        except Exception as e:
            self._error = str(e)
            raise

        self.running = True
        self._error = None
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self.running = False
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None
        if self.video:
            self.video.release()
            self.video = None
        if self.pipeline and self.pipeline.detector:
            self.pipeline.detector.reset_tracker()
        self.pipeline = None

    def get_status(self) -> dict:
        with self._lock:
            return {
                "running": self.running,
                "fps": round(self._fps, 1),
                "persons": list(self._latest_events),
                "error": self._error,
            }

    def mjpeg_generator(self):
        while self.running:
            with self._lock:
                jpg = self._latest_jpeg
            if jpg:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
                )
            time.sleep(0.04)

    def _loop(self):
        frame_count = 0
        fps_timer = time.time()
        det_cfg = self.pipeline.config.get("detection", {}) if self.pipeline else {}
        skip_frames = max(0, int(det_cfg.get("skip_frames", 0)))

        while self.running:
            if not self.video or not self.pipeline:
                break

            ok, frame, err = self.video.read()
            if not ok or frame is None:
                with self._lock:
                    self._error = err or "视频读取失败"
                time.sleep(0.3)
                continue

            if skip_frames > 0:
                for _ in range(skip_frames):
                    self.video.cap.read()

            try:
                _, events = self.pipeline.process_frame(frame)
                jpg = encode_frame_jpeg(frame, quality=80)

                frame_count += 1
                elapsed = time.time() - fps_timer
                if elapsed >= 1.0:
                    fps = frame_count / elapsed
                    frame_count = 0
                    fps_timer = time.time()
                    with self._lock:
                        self._fps = fps

                with self._lock:
                    self._latest_jpeg = jpg
                    self._latest_events = events
                    self._error = None
            except Exception as e:
                with self._lock:
                    self._error = str(e)
                time.sleep(0.3)
