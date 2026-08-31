"""OpenCV 画面中文绘制（PIL + 系统中文字体）"""

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

_FONT_CACHE: dict[int, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}

_FONT_PATHS = [
    Path("C:/Windows/Fonts/msyh.ttc"),      # 微软雅黑
    Path("C:/Windows/Fonts/msyhbd.ttc"),
    Path("C:/Windows/Fonts/simhei.ttf"),    # 黑体
    Path("C:/Windows/Fonts/simsun.ttc"),    # 宋体
    Path("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
]


def _get_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]
    for path in _FONT_PATHS:
        if path.exists():
            font = ImageFont.truetype(str(path), size=size)
            _FONT_CACHE[size] = font
            return font
    font = ImageFont.load_default()
    _FONT_CACHE[size] = font
    return font


def _bgr_to_rgb(color: tuple) -> tuple[int, int, int]:
    return (int(color[2]), int(color[1]), int(color[0]))


def draw_text(
    frame: np.ndarray,
    text: str,
    x: int,
    y: int,
    color_bgr: tuple,
    font_size: int = 20,
) -> None:
    """在 BGR 图像上绘制文本（支持中文）"""
    draw_texts(frame, [(text, x, y, color_bgr, font_size)])


def draw_texts(
    frame: np.ndarray,
    items: list[tuple[str, int, int, tuple, int]],
) -> None:
    """批量绘制文本，items: (text, x, y, color_bgr, font_size)"""
    if not items:
        return

    img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    img_pil = Image.fromarray(img_rgb)
    draw = ImageDraw.Draw(img_pil)

    for text, x, y, color_bgr, font_size in items:
        font = _get_font(font_size)
        draw.text((x, y), text, font=font, fill=_bgr_to_rgb(color_bgr))

    frame[:] = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
