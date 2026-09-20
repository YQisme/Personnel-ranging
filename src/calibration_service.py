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


def capture_frame(source: str, config: dict | None = None) -> np.ndarray:
    from src.video_source import is_rtsp, open_video_capture, resolve_path

    if config is not None:
        cam = dict(config.get("camera", {}))
        cfg = dict(config)
        cfg["camera"] = cam
        if is_rtsp(source):
            cam["rtsp_url"] = source
            cam["video_file"] = ""
        else:
            cam["video_file"] = resolve_path(source, cfg.get("_config_path"))
            cam["rtsp_url"] = ""
        cap = open_video_capture(cfg)
    else:
        resolved = resolve_path(source)
        cap = cv2.VideoCapture(resolved)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频源: {source}")
    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise RuntimeError("无法读取视频帧")
    return frame


def resolve_video_source(config_path: str = "config/config.yaml", override: str | None = None) -> str:
    from src.video_source import get_video_source

    path = Path(config_path)
    if not path.exists():
        return override or "0"
    with open(path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    config["_config_path"] = str(path.resolve())
    return get_video_source(config, override)


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
    labels: list[str] | None = None,
) -> dict:
    if len(pixel_points) < 4 or len(ground_points) < 4:
        raise ValueError("至少需要 4 个标定点（含原点）")

    pixel_tuples = [(float(p[0]), float(p[1])) for p in pixel_points]
    ground_tuples = [(float(g[0]), float(g[1])) for g in ground_points]

    has_origin = any(abs(g[0]) < 1e-9 and abs(g[1]) < 1e-9 for g in ground_tuples)
    if not has_origin:
        raise ValueError("请先指定原点 O（地面坐标 0, 0）")

    spread = check_ground_points_spread(ground_tuples)
    transformer = HomographyTransformer.from_points(pixel_tuples, ground_tuples)

    verification = []
    for i, (px, py) in enumerate(pixel_tuples):
        gx, gy = transformer.pixel_to_ground(px, py)
        expected = ground_tuples[i]
        error = ((gx - expected[0]) ** 2 + (gy - expected[1]) ** 2) ** 0.5
        if labels and i < len(labels):
            label = labels[i]
        elif abs(expected[0]) < 1e-9 and abs(expected[1]) < 1e-9:
            label = "O"
        else:
            label = get_label(i)
        verification.append({
            "label": label,
            "pixel": [round(px, 1), round(py, 1)],
            "ground": [round(gx, 2), round(gy, 2)],
            "expected_ground": [round(expected[0], 2), round(expected[1], 2)],
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
    labels: list[str] | None = None,
) -> dict:
    result = validate_calibration(pixel_points, ground_points, labels=labels)
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
