"""生成示例标定矩阵 — 仅标定画面内可见地面点（O 在画面外）"""

from pathlib import Path

from src.homography import HomographyTransformer

# 画面内可见点，地面坐标相对 O（摄像头投影点，通常在画面外）
PIXEL_POINTS = [
    (960, 900),    # A: 距 O 5m
    (960, 750),    # B: 距 O 10m
    (1100, 750),   # 10m 右侧 2m
    (820, 750),    # 10m 左侧 2m
    (960, 450),    # E: 距 O 20m
]

GROUND_POINTS = [
    (0.0, 5.0),
    (0.0, 10.0),
    (2.0, 10.0),
    (-2.0, 10.0),
    (0.0, 20.0),
]

LABELS = ["A(5m)", "B(10m)", "右10m", "左10m", "E(20m)"]


def main():
    output = Path("config/homography_matrix.npy")
    transformer = HomographyTransformer.from_points(PIXEL_POINTS, GROUND_POINTS)
    transformer.save(str(output), PIXEL_POINTS, GROUND_POINTS)

    print(f"示例标定矩阵已生成: {output}")
    print("\n验证 (距离 = 距 O 的地面距离，O 在画面外):")
    for i, (px, py) in enumerate(PIXEL_POINTS):
        gx, gy = transformer.pixel_to_ground(px, py)
        expected = GROUND_POINTS[i]
        dist = (gx ** 2 + gy ** 2) ** 0.5
        expected_dist = (expected[0] ** 2 + expected[1] ** 2) ** 0.5
        error = ((gx - expected[0]) ** 2 + (gy - expected[1]) ** 2) ** 0.5
        print(
            f"  {LABELS[i]}: ({px},{py}) → ({gx:.2f},{gy:.2f})m "
            f"距O {dist:.2f}m (期望 {expected_dist:.0f}m) 误差 {error:.3f}m"
        )


if __name__ == "__main__":
    main()
