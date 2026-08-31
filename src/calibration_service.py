"""标定业务逻辑（CLI 与 Web 共用）"""

from pathlib import Path

import cv2
import numpy as np
import yaml

from src.homography import HomographyTransformer, check_ground_points_spread
from src.video_source import open_video_capture

POINT_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"]


def get_label(index: int) -> str:
    if index < len(POINT_LABELS):
        return POINT_LABELS[index]
    return f"P{index}"


def ground_from_distance(distance: float, lateral: float = 0.0) -> tuple[float, float]:
    """主视野方向为 Y 轴，横向偏移为 X 轴"""
    return lateral, distance


def capture_frame(source: str, config: dict | None = None) -> np.ndarray:
    if config is not None:
        cam = dict(config.get("camera", {}))
        if source.startswith("rtsp://"):
            cam["rtsp_url"] = source
            cam["video_file"] = ""
        else:
            cam["video_file"] = source
            cam["rtsp_url"] = ""
        cap = open_video_capture({"camera": cam})
    else:
        cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频源: {source}")
    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise RuntimeError("无法读取视频帧")
    return frame


def resolve_video_source(config_path: str = "config/config.yaml", override: str | None = None) -> str:
    if override:
        return override
    path = Path(config_path)
    if not path.exists():
        return "0"
    with open(path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    camera = config.get("camera", {})
    return camera.get("video_file") or camera.get("rtsp_url") or "0"


def resolve_homography_path(config_path: str = "config/config.yaml") -> str:
    path = Path(config_path)
    if not path.exists():
        return "config/homography_matrix.npy"
    with open(path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    return config.get("calibration", {}).get("homography_file", "config/homography_matrix.npy")


def validate_calibration(
    pixel_points: list[list[float]],
    ground_points: list[list[float]],
) -> dict:
    if len(pixel_points) < 4 or len(ground_points) < 4:
        raise ValueError("至少需要 4 个标定点")

    pixel_tuples = [(float(p[0]), float(p[1])) for p in pixel_points]
    ground_tuples = [(float(g[0]), float(g[1])) for g in ground_points]

    spread = check_ground_points_spread(ground_tuples)
    transformer = HomographyTransformer.from_points(pixel_tuples, ground_tuples)

    verification = []
    for i, (px, py) in enumerate(pixel_tuples):
        gx, gy = transformer.pixel_to_ground(px, py)
        expected = ground_tuples[i]
        error = ((gx - expected[0]) ** 2 + (gy - expected[1]) ** 2) ** 0.5
        dist = (gx ** 2 + gy ** 2) ** 0.5
        verification.append({
            "label": get_label(i),
            "pixel": [round(px, 1), round(py, 1)],
            "ground": [round(gx, 2), round(gy, 2)],
            "expected_ground": [round(expected[0], 2), round(expected[1], 2)],
            "distance_from_o": round(dist, 2),
            "error_m": round(error, 3),
        })

    return {
        "collinear_warning": bool(spread["collinear_warning"]),
        "max_triangle_area": round(float(spread.get("max_triangle_area", 0)), 2),
        "verification": verification,
    }


def save_calibration(
    pixel_points: list[list[float]],
    ground_points: list[list[float]],
    output_path: str,
) -> dict:
    result = validate_calibration(pixel_points, ground_points)
    pixel_tuples = [(float(p[0]), float(p[1])) for p in pixel_points]
    ground_tuples = [(float(g[0]), float(g[1])) for g in ground_points]

    transformer = HomographyTransformer.from_points(pixel_tuples, ground_tuples)
    transformer.save(output_path, pixel_tuples, ground_tuples)

    result["saved_to"] = output_path
    return result


def encode_frame_jpeg(frame: np.ndarray, quality: int = 90) -> bytes:
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("图像编码失败")
    return buf.tobytes()
