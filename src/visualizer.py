"""可视化模块"""

import cv2

from src.motion_analyzer import MotionDirection, PersonMotionState
from src.text_draw import draw_texts

DIRECTION_LABELS = {
    MotionDirection.STATIONARY: "静止",
    MotionDirection.APPROACHING: "靠近摄像头",
    MotionDirection.RETREATING: "远离摄像头",
    MotionDirection.UNKNOWN: "未知",
}

DIRECTION_COLORS = {
    MotionDirection.STATIONARY: (200, 200, 200),
    MotionDirection.APPROACHING: (0, 0, 255),
    MotionDirection.RETREATING: (0, 255, 0),
    MotionDirection.UNKNOWN: (255, 255, 0),
}


def draw_person_info(frame, state: PersonMotionState):
    x1, y1, x2, y2 = [int(v) for v in state.bbox]
    color = DIRECTION_COLORS.get(state.direction, (255, 255, 255))

    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

    foot_x, foot_y = int(state.foot_x), int(state.foot_y)
    cv2.circle(frame, (foot_x, foot_y), 6, (0, 255, 255), -1)
    cv2.circle(frame, (foot_x, foot_y), 8, color, 2)

    direction_text = DIRECTION_LABELS.get(state.direction, "未知")
    lines = [
        f"#{state.person_id}",
        f"距摄像头 {state.distance:.2f}m",
        f"速度 {state.speed:.2f}m/s ({state.speed_kmh:.1f}km/h)",
        f"状态: {direction_text}",
    ]

    text_items = []
    text_y = y1 - 10
    font_size = 20
    for line in lines:
        text_y -= font_size + 4
        text_items.append((line, x1, text_y, color, font_size))

    draw_texts(frame, text_items)


def draw_camera_marker(frame, pixel_x: float, pixel_y: float):
    """绘制摄像头地面投影点 O（若在画面外则不绘制）"""
    h, w = frame.shape[:2]
    x, y = int(pixel_x), int(pixel_y)
    if x < 0 or x >= w or y < 0 or y >= h:
        return
    color = (255, 100, 0)
    cv2.drawMarker(frame, (x, y), color, cv2.MARKER_TILTED_CROSS, 24, 2)
    cv2.circle(frame, (x, y), 10, color, 2)
    draw_texts(frame, [("O", x + 14, y - 20, color, 18)])
