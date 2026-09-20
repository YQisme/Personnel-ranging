"""视频源 — 支持 RTSP / 本地视频 / 摄像头，RTSP 断线自动重连"""

from __future__ import annotations

import os
import time
from pathlib import Path

import cv2

# 常见本地视频扩展名
_VIDEO_EXTS = {".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".m4v", ".webm", ".ts"}


def _is_rtsp(source: str) -> bool:
    return source.lower().startswith("rtsp://")


def is_rtsp(source: str) -> bool:
    return _is_rtsp(source)


def _is_http_stream(source: str) -> bool:
    s = source.lower()
    return s.startswith("http://") or s.startswith("https://")


def _is_camera_index(source: str) -> bool:
    return source.isdigit()


def _looks_like_file(source: str) -> bool:
    if _is_rtsp(source) or _is_http_stream(source) or _is_camera_index(source):
        return False
    # 有扩展名或路径分隔符，视为本地文件
    p = Path(source)
    return bool(p.suffix.lower() in _VIDEO_EXTS or "/" in source or "\\" in source or p.exists())


def _apply_rtsp_env(transport: str = "tcp"):
    # TCP 比 UDP 更稳定；设置超时避免无限阻塞
    opts = f"rtsp_transport;{transport}|stimeout;5000000|max_delay;0"
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = opts


def resolve_path(source: str, config_path: str | None = None) -> str:
    """将相对路径解析为绝对路径（相对 cwd，再相对配置文件目录）"""
    if not _looks_like_file(source):
        return source
    p = Path(source)
    if p.is_absolute() and p.exists():
        return str(p)
    if p.exists():
        return str(p.resolve())
    if config_path:
        cfg_dir = Path(config_path).resolve().parent
        # config/config.yaml → 项目根目录
        for base in (cfg_dir, cfg_dir.parent):
            candidate = (base / source).resolve()
            if candidate.exists():
                return str(candidate)
    return str(p)


def get_video_source(config: dict, override: str | None = None) -> str:
    """优先 override → video_file → rtsp_url → 摄像头 0"""
    if override:
        source = str(override).strip()
    else:
        camera = config.get("camera", {})
        source = (
            str(camera.get("video_file") or "").strip()
            or str(camera.get("rtsp_url") or "").strip()
            or "0"
        )
    config_path = config.get("_config_path")
    return resolve_path(source, config_path)


def open_video_capture(config: dict, override: str | None = None) -> cv2.VideoCapture:
    camera = config.get("camera", {})
    source = get_video_source(config, override)
    transport = camera.get("rtsp_transport", "tcp")

    if _is_rtsp(source):
        _apply_rtsp_env(transport)

    if _is_camera_index(source):
        cap = cv2.VideoCapture(int(source))
    elif _is_rtsp(source) or _is_http_stream(source):
        cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
    else:
        # 本地视频：先检查文件是否存在，给出明确错误
        if _looks_like_file(source) and not Path(source).exists():
            raise RuntimeError(f"本地视频不存在: {source}")
        cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)

    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频源: {source}")

    # 减小缓冲，降低 RTSP 延迟和积压（本地文件也可设，无副作用）
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


class VideoSource:
    """带自动重连（流）/ 循环播放（本地文件）的视频读取"""

    def __init__(self, config: dict, override: str | None = None):
        self.config = config
        self.override = override
        self.source = get_video_source(config, override)
        self.cap: cv2.VideoCapture | None = None
        self._fail_count = 0
        cam = config.get("camera", {})
        self._max_fails = int(cam.get("max_read_fails", 5))
        self._reconnect_delay = float(cam.get("reconnect_delay", 2.0))
        self._loop = bool(cam.get("loop", True))
        self._is_rtsp = _is_rtsp(self.source) or _is_http_stream(self.source)
        self._is_file = _looks_like_file(self.source) and not self._is_rtsp
        self.ended = False  # 本地视频播放结束且不循环时为 True

    @property
    def is_file(self) -> bool:
        return self._is_file

    @property
    def is_stream(self) -> bool:
        return self._is_rtsp

    def open(self) -> bool:
        self.release()
        self.ended = False
        try:
            self.cap = open_video_capture(self.config, self.override)
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

    def _rewind(self) -> bool:
        """本地视频回到开头"""
        if self.cap is None:
            return self.open()
        ok = self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        if not ok:
            return self.open()
        self._fail_count = 0
        return True

    def get_fps(self, default: float = 25.0) -> float:
        if self.cap is None:
            return default
        fps = float(self.cap.get(cv2.CAP_PROP_FPS) or 0)
        return fps if fps > 1e-3 else default

    def read(self) -> tuple[bool, object | None, str | None]:
        """返回 (success, frame, error_message)"""
        if self.ended:
            return False, None, "视频已结束"

        if self.cap is None or not self.cap.isOpened():
            if self._is_file:
                if not self.open():
                    return False, None, f"无法打开本地视频: {self.source}"
            else:
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

        # 本地视频读失败：通常是播放结束
        if self._is_file:
            if self._loop:
                if self._rewind():
                    ret, frame = self.cap.read()
                    if ret and frame is not None:
                        return True, frame, None
                return False, None, "本地视频循环失败"
            self.ended = True
            return False, None, "视频已结束"

        # 流媒体：失败后重连
        self._fail_count += 1
        if self._fail_count >= self._max_fails:
            self.reconnect()
            return False, None, "视频断流，正在重新连接..."

        return False, None, "视频读取失败，正在重试..."
