"""YOLO 人员检测 + ByteTrack 跟踪 + 人体落地点计算"""

from dataclasses import dataclass
from ultralytics import YOLO


@dataclass
class PersonDetection:
    person_id: int
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    confidence: float
    foot_x: float
    foot_y: float


class PersonDetectorTracker:
    """YOLO 检测 + ByteTrack 跟踪"""

    def __init__(
        self,
        model_path: str = "yolov8n.pt",
        confidence: float = 0.5,
        tracker: str = "bytetrack.yaml",
        classes: list[int] | None = [0],
    ):
        self.model = YOLO(model_path)
        self.confidence = confidence
        self.tracker = tracker
        self.classes = set(classes or [0])
        self.imgsz = 640

    def detect_and_track(self, frame, imgsz: int | None = None) -> list[PersonDetection]:
        size = imgsz or self.imgsz
        results = self.model.track(
            frame,
            persist=True,
            conf=self.confidence,
            tracker=self.tracker,
            imgsz=size,
            verbose=False,
        )

        detections: list[PersonDetection] = []
        if not results or results[0].boxes is None:
            return detections

        boxes = results[0].boxes
        for i in range(len(boxes)):
            if boxes.cls is not None:
                cls_id = int(boxes.cls[i].item())
                if cls_id not in self.classes:
                    continue

            if boxes.id is None:
                continue

            person_id = int(boxes.id[i].item())
            x1, y1, x2, y2 = boxes.xyxy[i].tolist()
            conf = float(boxes.conf[i].item())

            foot_x = (x1 + x2) / 2
            foot_y = y2

            detections.append(
                PersonDetection(
                    person_id=person_id,
                    bbox=(x1, y1, x2, y2),
                    confidence=conf,
                    foot_x=foot_x,
                    foot_y=foot_y,
                )
            )

        return detections

    def reset_tracker(self):
        """重置 ByteTrack 状态（停止/重启检测时调用）"""
        if hasattr(self.model, "predictor") and self.model.predictor:
            self.model.predictor.trackers = None
