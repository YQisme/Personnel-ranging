"""生成示例标定矩阵 — 含原点 O 与多个相对坐标点"""

from pathlib import Path

from src.homography import HomographyTransformer

# O 为画面内原点；其余点相对 O 的地面坐标 (X, Y) 米
PIXEL_POINTS = [
    (960, 1000),   # O: (0, 0)
    (960, 900),    # A: (0, 5)
    (960, 750),    # B: (0, 10)
    (1100, 750),   # C: (2, 10)
    (820, 750),    # D: (-2, 10)
    (960, 450),    # E: (0, 20)
]

GROUND_POINTS = [
    (0.0, 0.0),
    (0.0, 5.0),
    (0.0, 10.0),
    (2.0, 10.0),
    (-2.0, 10.0),
    (0.0, 20.0),
]

LABELS = ["O", "A", "B", "C", "D", "E"]


def main():
    output = Path("config/homography_matrix.npy")
    transformer = HomographyTransformer.from_points(PIXEL_POINTS, GROUND_POINTS)
    transformer.save(str(output), PIXEL_POINTS, GROUND_POINTS)

    print(f"示例标定矩阵已生成: {output}")
    print("\n验证 (相对原点 O 的 X, Y):")
    for i, (px, py) in enumerate(PIXEL_POINTS):
        gx, gy = transformer.pixel_to_ground(px, py)
        expected = GROUND_POINTS[i]
        error = ((gx - expected[0]) ** 2 + (gy - expected[1]) ** 2) ** 0.5
        print(
            f"  {LABELS[i]}: ({px},{py}) → ({gx:.2f},{gy:.2f})m "
            f"期望 ({expected[0]:.1f},{expected[1]:.1f})m  误差 {error:.3f}m"
        )


if __name__ == "__main__":
    main()
