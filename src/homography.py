"""像素坐标 → 地面实际坐标的透视变换模块"""

import json
import numpy as np
from pathlib import Path


class HomographyTransformer:
    """使用单应性矩阵将像素坐标转换为地面实际坐标（米）"""

    def __init__(self, homography_matrix: np.ndarray | None = None):
        self.matrix = homography_matrix
        self.inverse_matrix = None
        if homography_matrix is not None:
            self.inverse_matrix = np.linalg.inv(homography_matrix)

    @classmethod
    def from_file(cls, filepath: str) -> "HomographyTransformer":
        path = Path(filepath)
        if not path.exists():
            raise FileNotFoundError(f"标定文件不存在: {filepath}")
        matrix = np.load(filepath)
        return cls(matrix)

    @classmethod
    def from_points(
        cls,
        pixel_points: list[tuple[float, float]],
        ground_points: list[tuple[float, float]],
    ) -> "HomographyTransformer":
        """从对应点计算单应性矩阵

        Args:
            pixel_points: 图像像素坐标 [(x, y), ...] 至少4个点
            ground_points: 地面实际坐标 [(X, Y) 米, ...]
        """
        if len(pixel_points) < 4 or len(ground_points) < 4:
            raise ValueError("至少需要4个对应点")
        src = np.array(pixel_points, dtype=np.float32)
        dst = np.array(ground_points, dtype=np.float32)
        matrix, _ = cv2_find_homography(src, dst)
        return cls(matrix)

    def pixel_to_ground(self, x: float, y: float) -> tuple[float, float]:
        """将像素坐标转换为地面坐标 (米)"""
        if self.matrix is None:
            raise RuntimeError("单应性矩阵未初始化")
        point = np.array([[[x, y]]], dtype=np.float32)
        transformed = cv2_perspective_transform(point, self.matrix)
        return float(transformed[0][0][0]), float(transformed[0][0][1])

    def ground_to_pixel(self, gx: float, gy: float) -> tuple[float, float]:
        """将地面坐标转换为像素坐标"""
        if self.inverse_matrix is None:
            raise RuntimeError("单应性矩阵未初始化")
        point = np.array([[[gx, gy]]], dtype=np.float32)
        transformed = cv2_perspective_transform(point, self.inverse_matrix)
        return float(transformed[0][0][0]), float(transformed[0][0][1])

    def save(self, filepath: str, pixel_points: list | None = None, ground_points: list | None = None):
        path = Path(filepath)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, self.matrix)
        if pixel_points and ground_points:
            meta_path = path.with_suffix(".json")
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(
                    {"pixel_points": pixel_points, "ground_points": ground_points},
                    f,
                    ensure_ascii=False,
                    indent=2,
                )


def cv2_find_homography(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, object]:
    import cv2
    matrix, status = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return matrix, status


def cv2_perspective_transform(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    import cv2
    return cv2.perspectiveTransform(points, matrix)


def compute_distance_from_origin(ground_x: float, ground_y: float) -> float:
    """计算地面点到摄像头投影点 O(0,0) 的距离 (米)"""
    return float((ground_x ** 2 + ground_y ** 2) ** 0.5)


def check_ground_points_spread(ground_points: list[tuple[float, float]]) -> dict:
    """检查标定点是否共线（共线时 Homography 不稳定）"""
    pts = np.array(ground_points, dtype=np.float64)
    if len(pts) < 3:
        return {"collinear_warning": False}

    # 用面积法：若所有点到首点连线的面积接近 0，则共线
    origin = pts[0]
    max_area = 0.0
    for i in range(1, len(pts) - 1):
        v1 = pts[i] - origin
        v2 = pts[i + 1] - origin
        area = abs(v1[0] * v2[1] - v1[1] * v2[0]) / 2.0
        max_area = max(max_area, area)

    collinear = max_area < 0.5  # 最大三角形面积 < 0.5 m²
    return {"collinear_warning": bool(collinear), "max_triangle_area": float(max_area)}
