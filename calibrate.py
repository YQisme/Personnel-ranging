"""交互式摄像机标定工具

标定原理：
  1. 第一个点 O = 坐标原点，地面坐标固定为 (0, 0)
  2. 后续点输入相对 O 的地面坐标 (X, Y) 米
  3. 用 Homography 建立 (x,y)像素 → (X,Y)地面坐标 映射
  4. 运行时人物框显示相对原点的 X、Y

建议标定点：
  - O: 自选原点（画面内可见地面点）
  - 至少再选 3 个分散的地面点，输入实测 (X, Y)
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
        self.window_name = "摄像机标定 - 原点 + (x,y)"
        self._awaiting_input = False

    def _next_label(self) -> str:
        if not self.point_labels:
            return "O"
        idx = len(self.point_labels) - 1  # 非原点序号
        if idx < len(self.POINT_LABELS):
            return self.POINT_LABELS[idx]
        return f"P{idx + 1}"

    def _redraw(self):
        self.display = self.frame.copy()
        if self.pixel_points:
            ox, oy = self.pixel_points[0]
            for i in range(1, len(self.pixel_points)):
                px, py = self.pixel_points[i]
                cv2.line(
                    self.display,
                    (int(ox), int(oy)),
                    (int(px), int(py)),
                    (0, 200, 255),
                    2,
                )

        for i, (px, py) in enumerate(self.pixel_points):
            label = self.point_labels[i]
            gx, gy = self.ground_points[i]
            is_origin = i == 0
            color = (0, 140, 255) if is_origin else (0, 255, 0)
            cv2.circle(self.display, (int(px), int(py)), 10 if is_origin else 8, color, -1)
            text = f"{label} ({gx:.1f},{gy:.1f})m"
            cv2.putText(
                self.display, text,
                (int(px) + 10, int(py) - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2,
            )

        hint = f"已标定 {len(self.pixel_points)} 点 | 左键添加 | s保存 | r重置 | q退出"
        cv2.putText(self.display, hint, (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    def mouse_callback(self, event, x, y, flags, param):
        if event != cv2.EVENT_LBUTTONDOWN or self._awaiting_input:
            return

        self._awaiting_input = True
        try:
            if not self.pixel_points:
                label = "O"
                print(f"\n{label} 原点像素坐标: ({x}, {y})")
                print("  → 地面坐标固定为 (0.0, 0.0)m")
                self.pixel_points.append((float(x), float(y)))
                self.ground_points.append((0.0, 0.0))
                self.point_labels.append(label)
            else:
                label = self._next_label()
                print(f"\n{label} 点像素坐标: ({x}, {y})")
                gx = float(input("  相对原点的 X (米，左负右正): "))
                gy = float(input("  相对原点的 Y (米): "))
                if abs(gx) < 1e-9 and abs(gy) < 1e-9:
                    print("  非原点不能为 (0,0)，已取消")
                else:
                    self.pixel_points.append((float(x), float(y)))
                    self.ground_points.append((gx, gy))
                    self.point_labels.append(label)
                    print(f"  → 地面坐标: ({gx:.1f}, {gy:.1f})m")
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
        print("摄像机地面标定（原点 + 相对坐标）")
        print("=" * 55)
        print("步骤:")
        print("  1. 点击画面指定原点 O（地面坐标 0, 0）")
        print("  2. 点击其他地面点，输入相对 O 的 X、Y（米）")
        print("  3. 点位尽量分散，避免共线")
        print("  4. 至少 4 个点（含 O）后按 's' 保存")
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
                print(f"至少需要 4 个点（含原点），当前 {len(self.pixel_points)} 个")

        cv2.destroyAllWindows()
        self.cap.release()

    def _save_calibration(self, output_path: str):
        spread = check_ground_points_spread(self.ground_points)
        if spread["collinear_warning"]:
            print("\n⚠ 警告: 标定点几乎共线，Homography 精度可能不足")
            print("  建议增加分散的横向/纵向点")

        transformer = HomographyTransformer.from_points(
            self.pixel_points, self.ground_points
        )
        transformer.save(output_path, self.pixel_points, self.ground_points)

        print("\n标定验证:")
        for i, (px, py) in enumerate(self.pixel_points):
            gx, gy = transformer.pixel_to_ground(px, py)
            expected = self.ground_points[i]
            error = np.sqrt((gx - expected[0]) ** 2 + (gy - expected[1]) ** 2)
            label = self.point_labels[i]
            print(
                f"  {label}: 像素({px:.0f},{py:.0f}) → "
                f"地面({gx:.2f},{gy:.2f})m  期望({expected[0]:.1f},{expected[1]:.1f})m"
                f"  误差 {error:.3f}m"
            )

        print(f"\n标定文件已保存: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="摄像机地面标定工具（原点 + x,y）")
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
