"""距离、速度、靠近/远离方向分析

坐标定义：标定原点 O(0,0) → 人员脚点 P(X,Y)
  显示：相对原点的 X、Y（米）
  距离：D = sqrt(X^2 + Y^2)，用于速度与靠近/远离判断

靠近/远离：相对原点的距离变化
  距离减少 → 靠近原点
  距离增加 → 远离原点
"""

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum

from src.kalman_filter import PositionKalmanFilter


class MotionDirection(Enum):
    STATIONARY = "stationary"
    APPROACHING = "approaching"   # 靠近摄像头
    RETREATING = "retreating"     # 远离摄像头
    UNKNOWN = "unknown"


@dataclass
class PersonMotionState:
    person_id: int
    ground_x: float = 0.0
    ground_y: float = 0.0
    distance: float = 0.0
    speed: float = 0.0
    speed_kmh: float = 0.0
    direction: MotionDirection = MotionDirection.UNKNOWN
    timestamp: float = 0.0
    foot_x: float = 0.0
    foot_y: float = 0.0
    bbox: tuple = (0, 0, 0, 0)


@dataclass
class TrackHistory:
    kalman: PositionKalmanFilter
    distance_history: deque = field(default_factory=lambda: deque(maxlen=50))
    direction_votes: deque = field(default_factory=lambda: deque(maxlen=10))
    last_update: float = 0.0
    confirmed_direction: MotionDirection = MotionDirection.UNKNOWN


class MotionAnalyzer:
    """分析人员运动：距摄像头距离、速度、靠近/远离"""

    def __init__(
        self,
        speed_window_seconds: float = 1.0,
        distance_threshold: float = 0.3,
        direction_confirm_frames: int = 5,
        kalman_process_noise: float = 0.1,
        kalman_measurement_noise: float = 1.0,
    ):
        self.speed_window_seconds = speed_window_seconds
        self.distance_threshold = distance_threshold
        self.direction_confirm_frames = direction_confirm_frames
        self._kalman_process_noise = kalman_process_noise
        self._kalman_measurement_noise = kalman_measurement_noise
        self.tracks: dict[int, TrackHistory] = {}

    def _get_or_create_track(self, person_id: int) -> TrackHistory:
        if person_id not in self.tracks:
            self.tracks[person_id] = TrackHistory(
                kalman=PositionKalmanFilter(
                    process_noise=self._kalman_process_noise,
                    measurement_noise=self._kalman_measurement_noise,
                )
            )
        return self.tracks[person_id]

    def update(
        self,
        person_id: int,
        ground_x: float,
        ground_y: float,
        foot_x: float,
        foot_y: float,
        bbox: tuple,
        timestamp: float | None = None,
    ) -> PersonMotionState:
        now = timestamp or time.time()
        track = self._get_or_create_track(person_id)

        # 卡尔曼滤波平滑地面坐标
        smooth_x, smooth_y = track.kalman.update(ground_x, ground_y)

        # 距摄像头地面投影点 O(0,0) 的距离
        distance = (smooth_x ** 2 + smooth_y ** 2) ** 0.5

        track.distance_history.append((now, distance))
        track.last_update = now

        # 基于距离变化率计算速度（沿靠近/远离方向）
        speed = self._compute_speed_from_distance(track.distance_history)
        speed_kmh = speed * 3.6

        direction = self._judge_direction(track)

        return PersonMotionState(
            person_id=person_id,
            ground_x=smooth_x,
            ground_y=smooth_y,
            distance=distance,
            speed=speed,
            speed_kmh=speed_kmh,
            direction=direction,
            timestamp=now,
            foot_x=foot_x,
            foot_y=foot_y,
            bbox=bbox,
        )

    def _compute_speed_from_distance(self, history: deque) -> float:
        """用滑动窗口内距离变化计算速度: v = |ΔD| / Δt"""
        if len(history) < 2:
            return 0.0

        window_start = history[-1][0] - self.speed_window_seconds
        window_points = [(t, d) for t, d in history if t >= window_start]

        if len(window_points) < 2:
            return 0.0

        t1, d1 = window_points[0]
        t2, d2 = window_points[-1]
        dt = t2 - t1
        if dt < 0.01:
            return 0.0

        return abs(d2 - d1) / dt

    def _judge_direction(self, track: TrackHistory) -> MotionDirection:
        if len(track.distance_history) < 2:
            return MotionDirection.UNKNOWN

        recent = list(track.distance_history)[-self.direction_confirm_frames:]
        if len(recent) < 2:
            return track.confirmed_direction

        # 距离减少 = 靠近摄像头，距离增加 = 远离摄像头
        delta = recent[-1][1] - recent[0][1]

        if abs(delta) < self.distance_threshold:
            vote = MotionDirection.STATIONARY
        elif delta < -self.distance_threshold:
            vote = MotionDirection.APPROACHING
        else:
            vote = MotionDirection.RETREATING

        track.direction_votes.append(vote)

        if len(track.direction_votes) >= self.direction_confirm_frames:
            votes = list(track.direction_votes)[-self.direction_confirm_frames:]
            if all(v == MotionDirection.APPROACHING for v in votes):
                track.confirmed_direction = MotionDirection.APPROACHING
            elif all(v == MotionDirection.RETREATING for v in votes):
                track.confirmed_direction = MotionDirection.RETREATING
            elif all(v == MotionDirection.STATIONARY for v in votes):
                track.confirmed_direction = MotionDirection.STATIONARY

        return track.confirmed_direction

    def remove_stale_tracks(self, max_age_seconds: float = 5.0):
        now = time.time()
        stale = [
            pid for pid, track in self.tracks.items()
            if now - track.last_update > max_age_seconds
        ]
        for pid in stale:
            del self.tracks[pid]

    def to_dict(self, state: PersonMotionState) -> dict:
        return {
            "person_id": state.person_id,
            "ground_x": round(state.ground_x, 2),
            "ground_y": round(state.ground_y, 2),
            "distance": round(state.distance, 2),
            "speed": round(state.speed, 2),
            "speed_kmh": round(state.speed_kmh, 2),
            "direction": state.direction.value,
            "timestamp": time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(state.timestamp)
            ),
        }
