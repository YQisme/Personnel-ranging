# YOLO 人员距离速度检测

基于 YOLO 人员检测 + ByteTrack 跟踪 + 摄像机地面标定，实现稳定的人员**距离**、**速度**、**靠近/远离摄像头**方向判断。适用于海康等固定摄像头的厂区监控场景。

## 功能

- **人员检测**：YOLOv8 检测 `person` 类别
- **多目标跟踪**：ByteTrack 为每个人分配稳定 ID
- **地面定位**：检测框底部中心点作为脚点，Homography 映射到地面坐标
- **距离计算**：人员到摄像头地面投影点 O 的地面距离（米）
- **速度计算**：滑动窗口内距离变化率，卡尔曼滤波平滑
- **方向判断**：距离持续减少 → 靠近摄像头；持续增加 → 远离摄像头

## 系统架构

```
海康摄像头 (RTSP)
    │
    ▼
视频解码
    │
    ▼
YOLO 人员检测
    │
    ▼
ByteTrack 跟踪 (person ID)
    │
    ▼
脚点计算 (bbox 底部中心)
    │
    ▼
Homography 透视变换
    │
    ├──────────────┐
    ▼              ▼
距离 D=√(X²+Y²)   距离变化率 → 速度
    │              │
    └──────┬───────┘
           ▼
    靠近 / 远离判断
           │
           ▼
    画面标注 / JSON 输出
```

## 距离定义

距离不是「人体框越大越近」，而是：

```
                 摄像头 📷
                     │
                     ▼
              O 摄像头地面投影点 (0, 0)
                     │
                     │  D 米
                     │
                     ● 👤 人员脚点 P(X, Y)

D = √(X² + Y²)
```

即：**摄像头正下方地面投影点 → 人员脚点** 的地面直线距离。

## 环境要求

- Python 3.10+
- Windows / Linux
- 可选：NVIDIA GPU（加速 YOLO 推理）

## 安装

```bash
cd yolo判断距离速度
pip install -r requirements.txt
```

首次运行会自动下载 YOLOv8 模型权重（`yolov8n.pt`）。

## 快速开始

### 1. 配置视频源

编辑 `config/config.yaml`：

```yaml
camera:
  rtsp_url: "rtsp://admin:密码@192.168.1.64:554/Streaming/Channels/101"
  # 或使用本地视频测试
  video_file: "test.mp4"
```

### 2. 摄像机标定（必做）

标定建立「像素坐标 → 地面坐标」映射，是距离计算的基础。

#### 方式一：Web 前端标定（推荐）

```bash
python web/server.py
```

浏览器打开 **http://127.0.0.1:8080**

1. 点击「从视频源抓拍」或「上传图片」加载画面
2. 在地面用卷尺从 **O**（摄像头正下方地面点）量出距离
3. 在画面上点击该**可见地面位置**，输入卷尺实测距离（5m / 10m / 15m / 20m）
4. 可选填写横向偏移（左右偏移点）
5. 至少 4 个点后点击「保存标定」

> **说明**：O 是坐标原点，通常在画面外（镜头正下方），**无需在画面上点击 O**。

自定义端口：

```bash
python web/server.py --host 0.0.0.0 --port 8080
```

#### 方式二：OpenCV 窗口标定

```bash
python calibrate.py
```

**标定步骤：**

1. **O 点**是坐标原点，通常在画面外，无需点击
2. 在地面用卷尺从 O 量距离，在画面上点击该位置并输入实测距离：
   - A：距 O **5m**
   - B：距 O **10m**
   - C：距 O **15m**
   - D：距 O **20m**
3. **建议增加横向点** — 同一距离处标左右偏移点（如 10m 处左右各 2m）
4. **至少 4 个点**后按 `s` 保存

**操作键：**

| 键 | 功能 |
|----|------|
| 左键 | 添加标定点 |
| `s` | 保存标定（至少 4 点） |
| `r` | 重置 |
| `q` | 退出 |

标定结果保存为：

- `config/homography_matrix.npy` — 单应性矩阵
- `config/homography_matrix.json` — 标定点元数据

**无摄像头时生成示例标定：**

```bash
python generate_sample_calibration.py
```

### 3. 运行检测

```bash
python main.py
```

按 `q` 退出。画面显示每个人员的 ID、距摄像头距离、速度、靠近/远离状态。

## 配置说明

`config/config.yaml` 主要参数：

| 参数 | 说明 | 默认 |
|------|------|------|
| `camera.rtsp_url` | 海康 RTSP 地址 | — |
| `camera.video_file` | 本地视频路径（优先于 RTSP） | — |
| `detection.model` | YOLO 模型 | `yolov8n.pt` |
| `detection.confidence` | 检测置信度 | `0.5` |
| `motion.speed_window_seconds` | 速度滑动窗口（秒） | `1.0` |
| `motion.distance_threshold` | 静止阈值（米） | `0.3` |
| `motion.direction_confirm_frames` | 方向确认帧数 | `5` |
| `output.save_video` | 是否保存结果视频 | `false` |
| `output.json_output` | JSON 事件输出路径 | `output/events.json` |

## 输出示例

**画面标注：**

```
#12
距摄像头 7.40m
速度 1.32m/s (4.8km/h)
状态: 靠近摄像头
```

**JSON 事件：**

```json
{
  "person_id": 12,
  "ground_x": 6.2,
  "ground_y": 8.5,
  "distance": 10.52,
  "speed": 1.32,
  "speed_kmh": 4.75,
  "direction": "approaching",
  "timestamp": "2026-08-31 10:30:21"
}
```

**方向字段 `direction`：**

| 值 | 含义 |
|----|------|
| `approaching` | 靠近摄像头（距离持续减少） |
| `retreating` | 远离摄像头（距离持续增加） |
| `stationary` | 静止（距离变化 < 0.3m） |
| `unknown` | 尚未确认 |

## 算法说明

### 脚点

不使用检测框中心，使用**底部中心点**：

```
foot_x = (x1 + x2) / 2
foot_y = y2
```

该点近似对应人在地面上的位置。

### 速度

不用每帧瞬时速度（抖动大），采用**滑动窗口内距离变化率**：

```
v = |D(t₂) - D(t₁)| / (t₂ - t₁)
```

默认窗口 1 秒。地面坐标经卡尔曼滤波平滑后再参与计算。

### 靠近 / 远离

比较窗口内距离变化，并加阈值与连续确认，避免检测框抖动误判：

```
|ΔD| < 0.3m        → 静止
ΔD < -0.3m         → 靠近摄像头
ΔD > +0.3m         → 远离摄像头
连续 5 帧满足       → 确认状态变更
```

## 项目结构

```
yolo判断距离速度/
├── config/
│   ├── config.yaml              # 主配置
│   ├── homography_matrix.npy    # 标定矩阵
│   └── homography_matrix.json   # 标定点元数据
├── src/
│   ├── detector.py              # YOLO + ByteTrack + 脚点
│   ├── homography.py            # 像素 ↔ 地面坐标变换
│   ├── kalman_filter.py         # 位置卡尔曼滤波
│   ├── motion_analyzer.py       # 距离 / 速度 / 方向
│   └── visualizer.py            # 画面标注
├── calibrate.py                 # OpenCV 窗口标定工具
├── web/
│   ├── server.py                # Web 标定服务
│   └── static/                  # 前端页面
├── generate_sample_calibration.py
├── main.py                      # 主程序入口
├── requirements.txt
└── README.md
```

## 海康 RTSP 地址格式

常见格式：

```
rtsp://admin:密码@IP:554/Streaming/Channels/101   # 主码流
rtsp://admin:密码@IP:554/Streaming/Channels/102   # 子码流
```

## 常见问题

**标定文件不存在**

先运行 `python calibrate.py` 完成标定，或 `python generate_sample_calibration.py` 生成示例。

**标定点几乎共线警告**

仅在一条线上标定时 Homography 精度不足。请在同一距离处增加左右横向偏移点。

**距离明显不准**

- 确认卷尺实测距离准确，标定点覆盖人员活动区域
- 增加标定点数量，覆盖人员可能出现的区域
- 检查卷尺实测距离是否准确

**RTSP 连接失败**

- 确认 IP、端口、账号密码
- 用 VLC 先验证 RTSP 是否可播
- 可改用 `video_file` 本地视频测试

## 后续扩展

- 多摄像头统一到厂区坐标系
- 跨摄像头连续跟踪
- 告警规则（如距摄像头 < 3m 且靠近时触发）
- 对接平台 API / WebSocket 推送
