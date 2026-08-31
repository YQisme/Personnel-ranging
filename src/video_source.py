"""视频源 — RTSP 优化与断线自动重连"""

import os
import time
from pathlib import Path

import cv2


def _is_rtsp(source: str) -> bool:
    return source.lower().startswith("rtsp://")


def _apply_rtsp_env(transport: str = "tcp"):
    # TCP 比 UDP 更稳定；设置超时避免无限阻塞
    opts = f"rtsp_transport;{transport}|stimeout;5000000|max_delay;0"
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = opts


def get_video_source(config: dict) -> str:
    camera = config.get("camera", {})
    return camera.get("video_file") or camera.get("rtsp_url") or "0"


def open_video_capture(config: dict) -> cv2.VideoCapture:
    camera = config.get("camera", {})
    source = get_video_source(config)
    transport = camera.get("rtsp_transport", "tcp")

    if _is_rtsp(source):
        _apply_rtsp_env(transport)

    cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG if _is_rtsp(source) else cv2.CAP_ANY)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频源: {source}")

    # 减小缓冲，降低 RTSP 延迟和积压
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


class VideoSource:
    """带自动重连的视频读取"""

    def __init__(self, config: dict):
        self.config = config
        self.source = get_video_source(config)
        self.cap: cv2.VideoCapture | None = None
        self._fail_count = 0
        self._max_fails = int(config.get("camera", {}).get("max_read_fails", 5))
        self._reconnect_delay = float(config.get("camera", {}).get("reconnect_delay", 2.0))
        self._is_rtsp = _is_rtsp(self.source)

    def open(self) -> bool:
        self.release()
        try:
            self.cap = open_video_capture(self.config)
            self._fail_count = 0
            return True
        except RuntimeError:
            return False

    def release(self):
        if self.cap is not None:
            self.cap.release()
            self.cap = None

    def reconnect(self) -> bool:
        self.release()
        time.sleep(self._reconnect_delay)
        return self.open()

    def read(self) -> tuple[bool, object | None, str | None]:
        """返回 (success, frame, error_message)"""
        if self.cap is None or not self.cap.isOpened():
            if not self.reconnect():
                return False, None, "无法连接视频源，正在重连..."

        # RTSP 积压时多读几次取最新帧
        ret, frame = self.cap.read()
        if self._is_rtsp and ret:
            for _ in range(2):
                r2, f2 = self.cap.read()
                if r2:
                    ret, frame = r2, f2

        if ret and frame is not None:
            self._fail_count = 0
            return True, frame, None

        self._fail_count += 1
        if self._fail_count >= self._max_fails:
            self.reconnect()
            return False, None, "视频断流，正在重新连接..."

        return False, None, "视频读取失败，正在重试..."
