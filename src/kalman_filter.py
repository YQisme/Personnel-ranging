"""卡尔曼滤波器，用于平滑地面坐标"""

import numpy as np
from filterpy.kalman import KalmanFilter


class PositionKalmanFilter:
    """2D 位置卡尔曼滤波器"""

    def __init__(self, process_noise: float = 0.1, measurement_noise: float = 1.0):
        self.kf = KalmanFilter(dim_x=4, dim_z=2)
        # 状态: [x, y, vx, vy]
        self.kf.F = np.array(
            [
                [1, 0, 1, 0],
                [0, 1, 0, 1],
                [0, 0, 1, 0],
                [0, 0, 0, 1],
            ],
            dtype=float,
        )
        self.kf.H = np.array(
            [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
            ],
            dtype=float,
        )
        self.kf.P *= 1000.0
        self.kf.R = np.eye(2) * measurement_noise
        self.kf.Q = np.eye(4) * process_noise
        self.initialized = False

    def update(self, x: float, y: float) -> tuple[float, float]:
        if not self.initialized:
            self.kf.x = np.array([x, y, 0, 0], dtype=float)
            self.initialized = True
        else:
            self.kf.predict()
            self.kf.update(np.array([x, y], dtype=float))
        return float(self.kf.x[0]), float(self.kf.x[1])

    def get_velocity(self) -> tuple[float, float]:
        if not self.initialized:
            return 0.0, 0.0
        return float(self.kf.x[2]), float(self.kf.x[3])

    def get_speed(self) -> float:
        vx, vy = self.get_velocity()
        return float(np.sqrt(vx ** 2 + vy ** 2))
