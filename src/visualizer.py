"""可视化模块"""

import cv2

from src.motion_analyzer import MotionDirection, PersonMotionState

_FONT = cv2.FONT_HERSHEY_SIMPLEX
_LINE_GAP = 22

DIRECTION_LABELS = {
    MotionDirection.STATIONARY: "Stationary",
    MotionDirection.APPROACHING: "Approaching",
    MotionDirection.RETREATING: "Retreating",
    MotionDirection.UNKNOWN: "Unknown",
}

DIRECTION_COLORS = {
    MotionDirection.STATIONARY: (200, 200, 200),
    MotionDirection.APPROACHING: (0, 0, 255),
    MotionDirection.RETREATING: (0, 255, 0),
    MotionDirection.UNKNOWN: (255, 255, 0),
}


def _put_lines(frame, lines: list[str], x: int, y: int, color, font_scale: float = 0.55):
    text_y = y
    for line in lines:
        text_y -= _LINE_GAP
        cv2.putText(
            frame, line, (x, text_y), _FONT, font_scale, color, 2, cv2.LINE_AA,
        )


def draw_person_info(frame, state: PersonMotionState):
    x1, y1, x2, y2 = [int(v) for v in state.bbox]
    color = DIRECTION_COLORS.get(state.direction, (255, 255, 255))

    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

    foot_x, foot_y = int(state.foot_x), int(state.foot_y)
    cv2.circle(frame, (foot_x, foot_y), 6, (0, 255, 255), -1)
    cv2.circle(frame, (foot_x, foot_y), 8, color, 2)

    direction_text = DIRECTION_LABELS.get(state.direction, "Unknown")
    lines = [
        f"#{state.person_id}",
        f"X {state.ground_x:.2f}m",
        f"Y {state.ground_y:.2f}m",
        f"Speed {state.speed:.2f}m/s ({state.speed_kmh:.1f}km/h)",
        direction_text,
    ]
    _put_lines(frame, lines, x1, y1 - 10, color)


def draw_camera_marker(frame, pixel_x: float, pixel_y: float):
    """绘制标定原点 O（若在画面外则不绘制）"""
    h, w = frame.shape[:2]
    x, y = int(pixel_x), int(pixel_y)
    if x < 0 or x >= w or y < 0 or y >= h:
        return
    color = (255, 100, 0)
    cv2.drawMarker(frame, (x, y), color, cv2.MARKER_TILTED_CROSS, 24, 2)
    cv2.circle(frame, (x, y), 10, color, 2)
    cv2.putText(frame, "O", (x + 14, y - 8), _FONT, 0.6, color, 2, cv2.LINE_AA)
