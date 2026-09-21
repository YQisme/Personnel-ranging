"""把人体检测框截成贴图，供三维模型使用。

等检测框四边都离开画面边缘，并且连续多帧大小稳定后才截取。
每个跟踪 ID 只锁定这一张，之后不再更换。
截图在画框和文字之前取，避免把标注画进贴图。
"""

import time
from collections import deque

import cv2
import numpy as np

_MIN_BOX_H = 72
_MIN_BOX_W = 28
_TEX_W = 72
_TEX_H = 144
_JPEG_QUALITY = 72
# 框贴到画面边缘时，人还没完全走进来
_EDGE_MARGIN = 2
# 连续这么多次「完整在画面内」且尺寸变化很小，才算稳定
_STABLE_FRAMES = 5
_SIZE_TOLERANCE = 0.12
# 检测中断超过此时长，稳定计数从头再来
_MAX_GAP_SEC = 0.6


def crop_appearance_jpeg(frame, bbox) -> bytes | None:
    """把 bbox 裁成固定尺寸的 JPEG。框太小或贴边无效时返回 None。"""
    if frame is None or frame.size == 0:
        return None
    x1, y1, x2, y2 = bbox
    height, width = frame.shape[:2]
    xa = max(0, min(width - 1, int(x1)))
    ya = max(0, min(height - 1, int(y1)))
    xb = max(0, min(width, int(x2)))
    yb = max(0, min(height, int(y2)))
    if xb - xa < _MIN_BOX_W or yb - ya < _MIN_BOX_H:
        return None
    crop = frame[ya:yb, xa:xb]
    if crop.size == 0:
        return None
    small = cv2.resize(crop, (_TEX_W, _TEX_H), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(
        ".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), _JPEG_QUALITY],
    )
    if not ok:
        return None
    return buf.tobytes()


def _fully_inside(frame, bbox) -> bool:
    """框的四边都离开画面边缘，说明人体已完整进入画面。"""
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = (float(v) for v in bbox)
    margin = _EDGE_MARGIN
    if x2 - x1 < _MIN_BOX_W or y2 - y1 < _MIN_BOX_H:
        return False
    return (
        x1 >= margin
        and y1 >= margin
        and x2 <= width - margin
        and y2 <= height - margin
    )


def _size_stable(samples) -> bool:
    """窗口内宽高相对变化都很小。人在走时框会平移，但尺寸应已稳住。"""
    if len(samples) < _STABLE_FRAMES:
        return False
    widths = [box[2] - box[0] for _t, box in samples]
    heights = [box[3] - box[1] for _t, box in samples]

    def settled(values) -> bool:
        mean = sum(values) / len(values)
        if mean < 1:
            return False
        return (max(values) - min(values)) / mean <= _SIZE_TOLERANCE

    return settled(widths) and settled(heights)


class AppearanceTracker:
    """等人完整进入画面并稳定后，按人员 ID 锁定一张人体框贴图。"""

    def __init__(self):
        self._jpeg: dict[int, bytes] = {}
        self._pending: dict[int, deque] = {}

    def observe(self, person_id: int, frame, bbox, timestamp: float | None = None) -> bool:
        if person_id in self._jpeg:
            return True
        now = time.time() if timestamp is None else timestamp
        history = self._pending.setdefault(person_id, deque(maxlen=_STABLE_FRAMES))
        if history and now - history[-1][0] > _MAX_GAP_SEC:
            history.clear()
        if frame is None or not _fully_inside(frame, bbox):
            history.clear()
            return False
        history.append((now, tuple(float(v) for v in bbox)))
        if not _size_stable(history):
            return False
        jpg = crop_appearance_jpeg(frame, bbox)
        history.clear()
        if jpg is None:
            return False
        self._jpeg[person_id] = jpg
        self._pending.pop(person_id, None)
        return True

    def get(self, person_id: int) -> bytes | None:
        return self._jpeg.get(person_id)

    def has(self, person_id: int) -> bool:
        return person_id in self._jpeg

    def retain(self, person_ids) -> None:
        live = set(person_ids)
        for store in (self._jpeg, self._pending):
            for pid in [key for key in store if key not in live]:
                del store[pid]
