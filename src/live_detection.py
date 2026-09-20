"""Web 实时检测服务 — 后台线程读帧 + MJPEG / WebSocket 输出"""

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
        self._cond = threading.Condition()
        self._latest_jpeg: bytes | None = None
        self._latest_events: list = []
        self._fps: float = 0.0
        self._error: str | None = None
        self._seq: int = 0

    def start(self):
        if self.running:
            return
        try:
            self.pipeline = DetectionPipeline(self.config_path)
            self.video = VideoSource(self.pipeline.config)
            if not self.video.open():
                raise RuntimeError(f"无法打开视频源: {self.video.source}")
        except Exception as e:
            with self._cond:
                self._error = str(e)
                self._cond.notify_all()
            raise

        self.running = True
        with self._cond:
            self._error = None
            self._seq += 1
            self._cond.notify_all()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self.running = False
        with self._cond:
            self._seq += 1
            self._cond.notify_all()

        # 先释放视频源，打断可能阻塞的 read()
        video = self.video
        self.video = None
        if video is not None:
            try:
                video.release()
            except Exception:
                pass

        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None

        if self.pipeline and self.pipeline.detector:
            try:
                self.pipeline.detector.reset_tracker()
            except Exception:
                pass
        self.pipeline = None
        with self._cond:
            self._latest_events = []
            self._latest_jpeg = None
            self._fps = 0.0
            self._seq += 1
            self._cond.notify_all()

    def get_status(self) -> dict:
        with self._cond:
            return {
                "running": self.running,
                "fps": round(self._fps, 1),
                "persons": list(self._latest_events),
                "error": self._error,
                "seq": self._seq,
            }

    def wait_status(self, last_seq: int, timeout: float = 1.0) -> dict:
        """阻塞直到有新帧（seq 变化）或超时，始终返回当前状态快照。"""
        with self._cond:
            if self._seq == last_seq:
                self._cond.wait(timeout=timeout)
            return {
                "running": self.running,
                "fps": round(self._fps, 1),
                "persons": list(self._latest_events),
                "error": self._error,
                "seq": self._seq,
            }

    def mjpeg_generator(self):
        try:
            while self.running:
                with self._cond:
                    jpg = self._latest_jpeg
                if jpg:
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
                    )
                # 短睡眠，便于 stop() 后尽快结束 StreamingResponse
                time.sleep(0.02)
        except (GeneratorExit, BrokenPipeError, ConnectionResetError):
            return

    def _publish(self, **kwargs):
        with self._cond:
            for key, value in kwargs.items():
                setattr(self, key, value)
            self._seq += 1
            self._cond.notify_all()

    def _loop(self):
        frame_count = 0
        fps_timer = time.time()
        det_cfg = self.pipeline.config.get("detection", {}) if self.pipeline else {}
        skip_frames = max(0, int(det_cfg.get("skip_frames", 0)))

        while self.running:
            video = self.video
            pipeline = self.pipeline
            if not video or not pipeline:
                break

            ok, frame, err = video.read()
            if not self.running:
                break
            if not ok or frame is None:
                self._publish(_error=err or "视频读取失败")
                if getattr(video, "ended", False):
                    self.running = False
                    self._publish()
                    break
                time.sleep(0.3)
                continue

            if skip_frames > 0 and video.cap is not None:
                for _ in range(skip_frames):
                    if not self.running:
                        break
                    video.cap.read()

            try:
                _, events = pipeline.process_frame(frame)
                if not self.running:
                    break
                jpg = encode_frame_jpeg(frame, quality=80)

                frame_count += 1
                elapsed = time.time() - fps_timer
                fps = self._fps
                if elapsed >= 1.0:
                    fps = frame_count / elapsed
                    frame_count = 0
                    fps_timer = time.time()

                self._publish(
                    _latest_jpeg=jpg,
                    _latest_events=events,
                    _fps=fps,
                    _error=None,
                )
            except Exception as e:
                if not self.running:
                    break
                self._publish(_error=str(e))
                time.sleep(0.3)
