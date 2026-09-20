"""主程序 - YOLO人员检测 + ByteTrack跟踪 + 距离/速度/方向分析"""

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import yaml

from src.detector import PersonDetectorTracker
from src.homography import HomographyTransformer
from src.motion_analyzer import MotionAnalyzer
from src.video_source import VideoSource, get_video_source
from src.visualizer import draw_camera_marker, draw_person_info


def load_config(config_path: str) -> dict:
    with open(config_path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    config["_config_path"] = str(Path(config_path).resolve())
    return config


def load_camera_origin_pixel(
    homography_path: str, transformer: HomographyTransformer,
) -> tuple[float, float]:
    """O 为坐标原点，用 Homography 反算像素位置（常在画面外）"""
    return transformer.ground_to_pixel(0.0, 0.0)


def main():
    parser = argparse.ArgumentParser(description="YOLO人员距离速度检测系统")
    parser.add_argument("--config", default="config/config.yaml")
    parser.add_argument(
        "--source",
        default=None,
        help="视频源：本地文件路径 / RTSP 地址 / 摄像头索引。覆盖 config 中的 video_file/rtsp_url",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    camera_cfg = config["camera"]
    det_cfg = config["detection"]
    track_cfg = config["tracking"]
    cal_cfg = config["calibration"]
    motion_cfg = config["motion"]
    output_cfg = config["output"]

    homography_path = cal_cfg["homography_file"]
    if not Path(homography_path).exists():
        print(f"标定文件不存在: {homography_path}")
        print("请先运行标定: python calibrate.py")
        sys.exit(1)

    transformer = HomographyTransformer.from_file(homography_path)
    print(f"已加载标定文件: {homography_path}")
    print("距离定义: 摄像头地面投影点 O(0,0) → 人员脚点")

    detector = PersonDetectorTracker(
        model_path=det_cfg["model"],
        confidence=det_cfg["confidence"],
        tracker=track_cfg["tracker"],
        classes=det_cfg["classes"],
    )

    analyzer = MotionAnalyzer(
        speed_window_seconds=motion_cfg["speed_window_seconds"],
        distance_threshold=motion_cfg["distance_threshold"],
        direction_confirm_frames=motion_cfg["direction_confirm_frames"],
        kalman_process_noise=motion_cfg["kalman_process_noise"],
        kalman_measurement_noise=motion_cfg["kalman_measurement_noise"],
    )

    video = VideoSource(config, override=args.source)
    if not video.open():
        print(f"无法打开视频源: {video.source}")
        sys.exit(1)

    source_display = get_video_source(config, args.source)
    print(f"视频源: {source_display}")

    cfg_fps = float(camera_cfg.get("fps", 25) or 25)
    fps = video.get_fps(cfg_fps)
    # 本地视频按帧率延时；RTSP/摄像头尽量低延迟
    wait_ms = max(1, int(1000 / fps)) if video.is_file else 1

    writer = None
    if output_cfg.get("save_video"):
        out_path = output_cfg["video_output"]
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        w = int(video.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(video.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(
            out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h)
        )

    events: list[dict] = []
    window_name = "人员距离速度检测"
    print("系统启动，按 'q' 退出")

    # O 点：摄像头地面投影点在画面中的位置
    origin_px, origin_py = load_camera_origin_pixel(homography_path, transformer)

    frame_count = 0
    while True:
        ok, frame, err = video.read()
        if not ok or frame is None:
            if video.ended:
                print("本地视频播放结束")
            else:
                print(err or "视频结束或读取失败")
            break

        frame_count += 1
        timestamp = time.time()

        detections = detector.detect_and_track(frame)

        states = []
        for det in detections:
            ground_x, ground_y = transformer.pixel_to_ground(det.foot_x, det.foot_y)

            state = analyzer.update(
                person_id=det.person_id,
                ground_x=ground_x,
                ground_y=ground_y,
                foot_x=det.foot_x,
                foot_y=det.foot_y,
                bbox=det.bbox,
                timestamp=timestamp,
            )
            states.append(state)

            event = analyzer.to_dict(state)
            events.append(event)

            if frame_count % 25 == 0:
                print(json.dumps(event, ensure_ascii=False))

        analyzer.remove_stale_tracks()

        draw_camera_marker(frame, origin_px, origin_py)
        for state in states:
            draw_person_info(frame, state)

        if output_cfg.get("show_window"):
            cv2.imshow(window_name, frame)
            if cv2.waitKey(wait_ms) & 0xFF == ord("q"):
                break

        if writer:
            writer.write(frame)

    json_path = output_cfg.get("json_output")
    if json_path and events:
        Path(json_path).parent.mkdir(parents=True, exist_ok=True)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(events, f, ensure_ascii=False, indent=2)
        print(f"事件数据已保存: {json_path}")

    video.release()
    if writer:
        writer.release()
    cv2.destroyAllWindows()
    print("系统已退出")


if __name__ == "__main__":
    main()
