"""检测流水线 — CLI 与 Web 实时预览共用"""

import json
import time
from pathlib import Path

import cv2
import yaml

from src.clothing_color import AppearanceTracker
from src.detector import PersonDetectorTracker
from src.homography import HomographyTransformer
from src.motion_analyzer import MotionAnalyzer
from src.video_source import open_video_capture
from src.visualizer import draw_camera_marker, draw_person_info


def load_config(config_path: str) -> dict:
    with open(config_path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    config["_config_path"] = str(Path(config_path).resolve())
    return config


def load_camera_origin_pixel(
    homography_path: str, transformer: HomographyTransformer,
) -> tuple[float, float]:
    """O 为坐标原点，用 Homography 反算像素位置（常在画面外）"""
    return transformer.ground_to_pixel(0.0, 0.0)


def open_video_source(config: dict) -> cv2.VideoCapture:
    return open_video_capture(config)


class DetectionPipeline:
    """单帧检测：YOLO → ByteTrack → Homography → 距离/速度/方向 → 画面标注"""

    def __init__(self, config_path: str = "config/config.yaml"):
        self.config_path = config_path
        self.config = load_config(config_path)
        cal_cfg = self.config["calibration"]
        det_cfg = self.config["detection"]
        track_cfg = self.config["tracking"]
        motion_cfg = self.config["motion"]

        homography_path = cal_cfg["homography_file"]
        if not Path(homography_path).exists():
            raise FileNotFoundError(f"标定文件不存在: {homography_path}")

        self.transformer = HomographyTransformer.from_file(homography_path)
        self.homography_path = homography_path

        self.detector = PersonDetectorTracker(
            model_path=det_cfg["model"],
            confidence=det_cfg["confidence"],
            tracker=track_cfg["tracker"],
            classes=det_cfg["classes"],
        )
        self.detector.imgsz = int(det_cfg.get("imgsz", 640))
        self.analyzer = MotionAnalyzer(
            speed_window_seconds=motion_cfg["speed_window_seconds"],
            distance_threshold=motion_cfg["distance_threshold"],
            direction_confirm_frames=motion_cfg["direction_confirm_frames"],
            kalman_process_noise=motion_cfg["kalman_process_noise"],
            kalman_measurement_noise=motion_cfg["kalman_measurement_noise"],
        )
        self.origin_px, self.origin_py = load_camera_origin_pixel(
            homography_path, self.transformer,
        )
        self.appearance = AppearanceTracker()

    def process_frame(self, frame, timestamp: float | None = None) -> tuple[list, list]:
        now = timestamp or time.time()
        detections = self.detector.detect_and_track(frame)
        states = []

        for det in detections:
            ground_x, ground_y = self.transformer.pixel_to_ground(det.foot_x, det.foot_y)
            state = self.analyzer.update(
                person_id=det.person_id,
                ground_x=ground_x,
                ground_y=ground_y,
                foot_x=det.foot_x,
                foot_y=det.foot_y,
                bbox=det.bbox,
                timestamp=now,
            )
            # 标注画上去之前截框，贴图里才是衣服本身的颜色
            self.appearance.observe(det.person_id, frame, det.bbox, timestamp=now)
            states.append(state)

        self.analyzer.remove_stale_tracks()
        self.appearance.retain(self.analyzer.tracks.keys())

        draw_camera_marker(frame, self.origin_px, self.origin_py)
        for state in states:
            draw_person_info(frame, state)

        events = []
        for state in states:
            event = self.analyzer.to_dict(state)
            event["has_appearance"] = self.appearance.has(state.person_id)
            events.append(event)
        return states, events
