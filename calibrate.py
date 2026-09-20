"""交互式摄像机标定工具

标定原理：
  1. 第一个点 O = 摄像头地面投影点，地面坐标固定为 (0, 0)
  2. 后续点在地面上实测距 O 的距离，在画面中点击对应像素位置
  3. 用 Homography 建立 (x,y)像素 → (X,Y)地面坐标 映射
  4. 运行时距离 = sqrt(X^2 + Y^2)，即 O 到脚点的地面距离

建议标定点：
  - O: 摄像头正下方地面点 (0, 0)
  - 沿主视野方向: 5m, 10m, 15m, 20m 各一个点
  - 左右两侧各加一个横向偏移点（提高透视精度，避免共线退化）
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
import yaml

from src.homography import HomographyTransformer, check_ground_points_spread
from src.video_source import open_video_capture, resolve_path


class CalibrationTool:
    POINT_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"]

    def __init__(self, image_source: str, config: dict | None = None):
        cfg = dict(config or {})
        cam = dict(cfg.get("camera", {}))
        cfg["camera"] = cam
        source = resolve_path(image_source, cfg.get("_config_path"))
        # 用 override 打开任意源（本地文件 / RTSP / 摄像头）
        self.cap = open_video_capture(cfg, override=source)
        if not self.cap.isOpened():
            raise RuntimeError(f"无法打开视频源: {source}")

        ret, self.frame = self.cap.read()
        if not ret:
            raise RuntimeError("无法读取第一帧")

        self.pixel_points: list[tuple[float, float]] = []
        self.ground_points: list[tuple[float, float]] = []
        self.point_labels: list[str] = []
        self.display = self.frame.copy()
        self.window_name = "摄像机标定 - 距离链标定"
        self._awaiting_input = False

    def _redraw(self):
        self.display = self.frame.copy()
        for i, (px, py) in enumerate(self.pixel_points):
            label = self.point_labels[i]
            gx, gy = self.ground_points[i]
            cv2.circle(self.display, (int(px), int(py)), 8, (0, 255, 0), -1)
            dist = (gx ** 2 + gy ** 2) ** 0.5
            text = f"{label} {dist:.0f}m"
            cv2.putText(
                self.display, text,
                (int(px) + 10, int(py) - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2,
            )
        # 连线显示标定路径
        if len(self.pixel_points) >= 2:
            pts = np.array([(int(p[0]), int(p[1])) for p in self.pixel_points], dtype=np.int32)
            cv2.polylines(self.display, [pts], False, (0, 200, 255), 2)

        hint = f"已标定 {len(self.pixel_points)} 点 | 左键添加 | s保存 | r重置 | q退出"
        cv2.putText(self.display, hint, (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    def mouse_callback(self, event, x, y, flags, param):
        if event != cv2.EVENT_LBUTTONDOWN or self._awaiting_input:
            return

        idx = len(self.pixel_points)
        label = self.POINT_LABELS[idx] if idx < len(self.POINT_LABELS) else f"P{idx + 1}"

        self._awaiting_input = True
        print(f"\n{label} 点像素坐标: ({x}, {y})")
        try:
            dist = float(input("  输入该点距 O 的地面距离 (米，卷尺实测): "))
            lateral = input("  横向偏移 (米，左负右正，直接回车=0): ").strip()
            lateral = float(lateral) if lateral else 0.0
            gx, gy = lateral, dist
            self.pixel_points.append((float(x), float(y)))
            self.ground_points.append((gx, gy))
            self.point_labels.append(label)
            print(f"  → 地面坐标: ({gx:.1f}, {gy:.1f})m，距 O {dist:.1f}m")
        except (ValueError, EOFError):
            print("  输入无效，已取消")
        finally:
            self._awaiting_input = False

        self._redraw()
        cv2.imshow(self.window_name, self.display)

    def run(self, output_path: str):
        cv2.namedWindow(self.window_name)
        cv2.setMouseCallback(self.window_name, self.mouse_callback)
        self._redraw()

        print("=" * 55)
        print("摄像机距离链标定")
        print("=" * 55)
        print("步骤:")
        print("  O 点是坐标原点，通常在画面外，无需点击")
        print("  1. 在地面用卷尺从 O 量出距离（5m / 10m / 15m / 20m）")
        print("  2. 在画面上点击该地面位置，输入实测距离")
        print("  3. 建议在同一距离加左右横向偏移点")
        print("  4. 至少 4 个点后按 's' 保存")
        print("=" * 55)

        while True:
            cv2.imshow(self.window_name, self.display)
            key = cv2.waitKey(30) & 0xFF

            if key == ord("q"):
                break

            if key == ord("r"):
                self.pixel_points.clear()
                self.ground_points.clear()
                self.point_labels.clear()
                self._redraw()
                print("已重置")

            if key == ord("s") and len(self.pixel_points) >= 4:
                self._save_calibration(output_path)
                print("\n标定完成！按任意键退出...")
                cv2.waitKey(0)
                break
            elif key == ord("s"):
                print(f"至少需要 4 个点，当前 {len(self.pixel_points)} 个")

        cv2.destroyAllWindows()
        self.cap.release()

    def _save_calibration(self, output_path: str):
        spread = check_ground_points_spread(self.ground_points)
        if spread["collinear_warning"]:
            print("\n⚠ 警告: 标定点几乎共线，Homography 精度可能不足")
            print("  建议在同一距离处增加左右横向偏移点")

        transformer = HomographyTransformer.from_points(
            self.pixel_points, self.ground_points
        )
        transformer.save(output_path, self.pixel_points, self.ground_points)

        print("\n标定验证:")
        for i, (px, py) in enumerate(self.pixel_points):
            gx, gy = transformer.pixel_to_ground(px, py)
            expected = self.ground_points[i]
            error = np.sqrt((gx - expected[0]) ** 2 + (gy - expected[1]) ** 2)
            dist = (gx ** 2 + gy ** 2) ** 0.5
            label = self.point_labels[i]
            print(
                f"  {label}: 像素({px:.0f},{py:.0f}) → "
                f"地面({gx:.2f},{gy:.2f})m 距O {dist:.2f}m  误差 {error:.3f}m"
            )

        print(f"\n标定文件已保存: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="摄像机距离链标定工具")
    parser.add_argument("--config", default="config/config.yaml")
    parser.add_argument("--source", default=None)
    parser.add_argument("--output", default="config/homography_matrix.npy")
    args = parser.parse_args()

    config_path = Path(args.config)
    config: dict = {}
    if config_path.exists():
        with open(config_path, encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
        config["_config_path"] = str(config_path.resolve())
        camera = config.get("camera", {})
        source = args.source or camera.get("video_file") or camera.get("rtsp_url") or "0"
    else:
        source = args.source or "0"

    tool = CalibrationTool(source, config)
    tool.run(args.output)


if __name__ == "__main__":
    main()
