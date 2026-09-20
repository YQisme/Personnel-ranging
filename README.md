# YOLO 人员距离速度检测

基于 YOLO 人员检测 + ByteTrack 跟踪 + 摄像机地面标定，实现稳定的人员**距离**、**速度**、**靠近/远离摄像头**方向判断。适用于固定摄像头的厂区监控场景。

支持两种使用方式：

- **命令行**：`main.py` 本地 OpenCV 窗口实时预览
- **Web 界面**：标定 + 浏览器实时监控（MJPEG 流 + 人员列表）+ Three.js 3D 人员轨迹

## 功能

- **人员检测**：YOLOv8 检测 `person` 类别
- **多目标跟踪**：ByteTrack 为每个人分配稳定 ID
- **地面定位**：检测框底部中心点作为脚点，Homography 映射到地面坐标
- **距离计算**：人员到摄像头地面投影点 O 的地面距离（米）
- **速度计算**：滑动窗口内距离变化率，卡尔曼滤波平滑
- **方向判断**：距离持续减少 → 靠近摄像头；持续增加 → 远离摄像头
- **RTSP / 本地视频**：TCP 传输、小缓冲、流断线自动重连；本地文件支持循环播放
- **画面标注**：OpenCV 英文叠加（低延迟，无 PIL 整帧转换）
- **3D 轨迹进出场**：人物模型从检测区外侧淡入走进，丢失跟踪后沿行进方向走离并淡出，避免凭空出现/消失

## 系统架构

```
摄像头 (RTSP) / 本地视频
    │
    ▼
视频解码 (VideoSource，可选自动重连)
    │
    ▼
YOLO 人员检测 + ByteTrack 跟踪
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
           ├─────────────┬──────────────┐
           ▼             ▼              ▼
    OpenCV 画面标注   JSON 事件    Web MJPEG 流    Three.js 3D 轨迹
    (main.py)      (output/)     (/monitor)      (/trajectory)
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
- 可选：NVIDIA GPU + CUDA（显著加速 YOLO 推理）

## 安装

```bash
cd yolo判断距离速度
pip install -r requirements.txt
```

首次运行会自动下载 YOLOv8 模型权重（默认 `yolov8n.pt`）。

**依赖概览：**

| 包 | 用途 |
|----|------|
| ultralytics | YOLOv8 检测与 ByteTrack |
| opencv-python | 视频读写、画面标注 |
| filterpy | 卡尔曼滤波 |
| fastapi / uvicorn | Web 标定与实时监控 |
| pyyaml | 配置文件 |

## 快速开始

### 1. 配置视频源

编辑 `config/config.yaml`，**二选一**：

**方式 A：本地视频（离线调试推荐）**

```yaml
camera:
  rtsp_url: ""
  video_file: "videos/test.mp4"   # 相对项目根目录，或写绝对路径
  loop: true                      # 播放结束后是否循环
```

**方式 B：RTSP 摄像头**

```yaml
camera:
  rtsp_url: "rtsp://admin:密码@192.168.1.64:554/Streaming/Channels/101"
  video_file: ""                  # 留空才走 RTSP
  rtsp_transport: tcp
```

> 优先级：`video_file`（非空）→ `rtsp_url` → 摄像头 `0`。也可用命令行 `--source` 临时覆盖。

命令行直接指定本地视频，无需改配置：

```bash
python main.py --source videos/test.mp4
python main.py --source E:/data/sample.mp4
python calibrate.py --source videos/test.mp4
```

### 2. 摄像机标定（必做）

标定建立「像素坐标 → 地面坐标」映射，是距离计算的基础。O 点为坐标原点 `(0, 0)`，**通常在画面外，无需在画面上点击**。

#### 方式一：Web 标定（推荐）

```bash
python web/server.py
```

默认监听 `0.0.0.0:8080`，本机与局域网设备均可访问：

- 本机：**http://127.0.0.1:8080**
- 局域网：启动时终端会打印本机 IP，其他设备打开 **http://\<本机IP\>:8080**（需同一网段；若打不开请放行 Windows 防火墙端口）

1. 点击「从视频源抓拍」或「上传图片」加载画面
2. 在地面用卷尺从 **O**（摄像头正下方地面点）量出距离
3. 在画面上点击该**可见地面位置**，输入卷尺实测距离（如 5m / 10m / 15m / 20m）
4. 可选填写横向偏移（左负右正，提高透视精度）
5. 至少 4 个点后点击「保存标定」

仅本机访问 / 自定义端口：

```bash
python web/server.py --host 127.0.0.1 --port 8080
```

#### 方式二：OpenCV 窗口标定

```bash
python calibrate.py
# 或指定配置 / 视频源
python calibrate.py --config config/config.yaml --source test.mp4
```

**标定步骤：**

1. 在地面用卷尺从 O 量距离，在画面上点击该位置并输入实测距离
2. 建议沿主视野方向标 5m / 10m / 15m / 20m，并在同一距离加左右横向点
3. 至少 **4 个点**后按 `s` 保存

**操作键：**

| 键 | 功能 |
|----|------|
| 左键 | 添加标定点（终端输入距离） |
| `s` | 保存标定（至少 4 点） |
| `r` | 重置 |
| `q` | 退出 |

标定结果：

- `config/homography_matrix.npy` — 单应性矩阵
- `config/homography_matrix.json` — 标定点元数据

**无摄像头时生成示例标定：**

```bash
python generate_sample_calibration.py
```

### 3. 运行检测

#### 方式 A：命令行（OpenCV 窗口）

```bash
python main.py
# 指定配置
python main.py --config config/config.yaml
# 直接用本地视频（覆盖配置中的视频源）
python main.py --source videos/test.mp4
```

按 `q` 退出。可选保存视频与 JSON 事件（见配置 `output.*`）。

#### 方式 B：Web 实时监控

```bash
python web/server.py
```

打开 **http://127.0.0.1:8080/monitor**（局域网用启动时打印的本机 IP）

1. 确认已完成标定
2. 点击「开始检测」
3. 左侧为 MJPEG 实时画面，右侧为当前检测到的人员列表（距离 / 速度 / 方向）

#### 方式 C：Three.js 3D 人员轨迹

打开 **http://127.0.0.1:8080/trajectory**（局域网同样用本机 IP）

1. 确认已完成标定
2. 点击「开始检测」（与监控页共用同一检测服务）
3. 通过 **WebSocket** `ws://…/ws/detect` 按帧推送人员坐标，驱动 3D 模型
4. 根据速度切换 Idle / Walk / Run，并绘制彩色轨迹线
5. 左键拖拽旋转、中键/右键平移、滚轮缩放；可跟随最近人员或清空轨迹

**人物生命周期（符合自然出现/消失）：**

| 阶段 | 行为 |
|------|------|
| 出场 `spawning` | 在检测落点外侧约 2.4m 生成，朝落点走入，约 0.7s 淡入并略微放大 |
| 在场 `active` | 平滑追赶地面坐标，按速度播 Idle / Walk / Run，累积轨迹线 |
| 离场 `exiting` | 跟踪丢失约 3 秒后，沿最后行进方向继续走，约 0.9s 淡出后移除；若跟踪恢复则取消离场并淡回 |

落点使用标定地面直角坐标 `(ground_x, ground_y)`（非极径距离 D），3D 中世界坐标为 `(worldX, worldZ) = (-ground_x, ground_y)`。

Web 服务提供标定页（`/`）、监控页（`/monitor`）与 3D 轨迹页（`/trajectory`），共用 `config/config.yaml` 中的视频源与标定文件。

## 画面标注说明

视频叠加文字使用 **OpenCV `putText`（英文）**，避免 PIL 整帧转换带来的延迟。

**叠加示例：**

```
#12
Dist 7.40m
Speed 1.32m/s (4.8km/h)
Approaching
```

**框与文字颜色：**

| 颜色 | 含义 |
|------|------|
| 红色 | 靠近摄像头（Approaching） |
| 绿色 | 远离摄像头（Retreating） |
| 灰色 | 静止（Stationary） |
| 黄色 | 方向未确认（Unknown） |
| 青色圆点 | 脚点位置 |
| 橙色十字 | 摄像头地面投影点 O（若在画面内） |

## 配置说明

主配置文件：`config/config.yaml`

### camera — 视频源

| 参数 | 说明 | 默认 |
|------|------|------|
| `rtsp_url` | RTSP 地址 | — |
| `video_file` | 本地视频路径（非空时优先于 `rtsp_url`） | `""` |
| `loop` | 本地视频结束后是否循环播放 | `true` |
| `width` / `height` / `fps` | 参考分辨率与帧率 | 1920×1080 @ 25 |
| `rtsp_transport` | RTSP 传输协议 | `tcp` |
| `max_read_fails` | 连续读帧失败多少次后重连（仅流媒体） | `5` |
| `reconnect_delay` | 重连等待秒数 | `2` |

### detection — YOLO 检测

| 参数 | 说明 | 默认 |
|------|------|------|
| `model` | 模型权重 | `yolov8n.pt` |
| `confidence` | 检测置信度阈值 | `0.5` |
| `classes` | 检测类别 ID 列表 | `[0]`（person） |
| `imgsz` | 推理输入尺寸，越小越快 | `640` |
| `skip_frames` | 每推理 1 帧额外跳过的读帧数；`1` 表示隔帧检测 | `0` |

### tracking — ByteTrack

| 参数 | 说明 | 默认 |
|------|------|------|
| `tracker` | 跟踪器配置 | `bytetrack.yaml` |
| `persist` | 跨帧保持跟踪 ID | `true` |

### calibration — 标定

| 参数 | 说明 | 默认 |
|------|------|------|
| `homography_file` | 标定矩阵路径 | `config/homography_matrix.npy` |

### motion — 运动分析

| 参数 | 说明 | 默认 |
|------|------|------|
| `speed_window_seconds` | 速度滑动窗口（秒） | `1.0` |
| `distance_threshold` | 静止阈值（米），\|ΔD\| 小于此值视为静止 | `0.3` |
| `direction_confirm_frames` | 方向变更需连续满足的帧数 | `5` |
| `kalman_process_noise` | 卡尔曼过程噪声 | `0.1` |
| `kalman_measurement_noise` | 卡尔曼观测噪声 | `1.0` |

### output — 命令行输出（`main.py`）

| 参数 | 说明 | 默认 |
|------|------|------|
| `show_window` | 是否显示 OpenCV 窗口 | `true` |
| `save_video` | 是否保存标注视频 | `false` |
| `video_output` | 视频输出路径 | `output/result.mp4` |
| `json_output` | JSON 事件输出路径 | `output/events.json` |

## 输出示例

**JSON 事件（Web `/api/detect/status` 与 `main.py` 均使用同一结构）：**

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
| `stationary` | 静止（距离变化 < 阈值） |
| `unknown` | 尚未确认 |

## 性能调优

若画面或 Web 流延迟较大，可按优先级尝试：

1. **使用 GPU**：安装 CUDA 版 PyTorch，YOLO 会自动使用 GPU
2. **降低推理尺寸**：`detection.imgsz: 480` 或 `320`
3. **隔帧检测**：`detection.skip_frames: 1`（跟踪仍保持，适合 25fps 以上）
4. **换更小模型**：`yolov8n.pt`（已是最小）；或确认未误用 `yolov8x`
5. **RTSP 子码流**：改用 `Channels/102` 降低解码压力（需重新标定或保证视角一致）
6. **Web 场景**：监控页为 MJPEG，编码与网络也会带来额外延迟；本地调试可用 `main.py`

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

阈值与确认帧数可在 `motion.*` 中调整。

## 项目结构

```
yolo判断距离速度/
├── config/
│   ├── config.yaml              # 主配置
│   ├── homography_matrix.npy    # 标定矩阵（运行后生成）
│   └── homography_matrix.json   # 标定点元数据
├── src/
│   ├── detector.py              # YOLO + ByteTrack + 脚点
│   ├── homography.py            # 像素 ↔ 地面坐标变换
│   ├── kalman_filter.py         # 位置卡尔曼滤波
│   ├── motion_analyzer.py       # 距离 / 速度 / 方向
│   ├── visualizer.py            # OpenCV 英文画面标注
│   ├── pipeline.py              # 检测流水线（Web 与扩展共用）
│   ├── live_detection.py        # Web 后台检测线程 + MJPEG
│   ├── video_source.py          # RTSP / 本地视频 / 摄像头读写
│   └── calibration_service.py   # Web 标定 API 逻辑
├── calibrate.py                 # OpenCV 窗口标定工具
├── main.py                      # 命令行主入口
├── generate_sample_calibration.py
├── web/
│   ├── server.py                # FastAPI：标定 + 实时监控 + 3D 轨迹
│   └── static/                  # 前端（标定 / 监控 / Three.js 轨迹）
│       └── models/Human.glb     # 真人骨骼模型（Idle/Walk/Run）
├── requirements.txt
└── README.md
```

## Web API 摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 标定页面 |
| GET | `/monitor` | 实时监控页面 |
| GET | `/trajectory` | Three.js 3D 人员轨迹页面 |
| GET | `/api/status` | 标定状态、视频源、检测是否运行 |
| POST | `/api/capture` | 从配置的视频源抓拍一帧 |
| POST | `/api/upload` | 上传标定用图片 |
| GET | `/api/frame` | 当前标定帧 JPEG |
| GET | `/api/existing` | 读取已有标定点 |
| POST | `/api/validate` | 校验标定点 |
| POST | `/api/save` | 保存标定 |
| POST | `/api/detect/start` | 启动后台检测 |
| POST | `/api/detect/stop` | 停止检测 |
| GET | `/api/detect/status` | FPS、人员列表、错误信息（HTTP 快照） |
| GET | `/api/detect/stream` | MJPEG 实时流 |
| WS | `/ws/detect` | 检测结果按帧推送（`type=status` / `ping`） |

## 视频源格式

**本地视频**（`mp4` / `avi` / `mkv` / `mov` 等）：

```
videos/test.mp4
E:/data/sample.mp4
```

**RTSP**（常见海康格式）：

```
rtsp://admin:密码@IP:554/Streaming/Channels/101   # 主码流
rtsp://admin:密码@IP:554/Streaming/Channels/102   # 子码流
```

## 常见问题

**标定文件不存在**

先完成 Web 或 `calibrate.py` 标定，或运行 `python generate_sample_calibration.py` 生成示例（仅用于流程测试，距离不准）。

**标定点几乎共线警告**

仅在一条线上标定时 Homography 精度不足。请在同一距离处增加左右横向偏移点。

**距离明显不准**

- 确认卷尺实测距离准确，标定点覆盖人员活动区域
- 增加标定点数量，覆盖人员可能出现的区域
- 摄像头位置或俯仰角变化后需重新标定

**RTSP 连接失败**

- 确认 IP、端口、账号密码
- 用 VLC 先验证 RTSP 是否可播
- 检查 `rtsp_transport`（建议 `tcp`）
- 可改用 `video_file` 本地视频测试

**本地视频打不开**

- 确认 `video_file` 路径正确（相对路径相对项目根目录）
- 或用 `python main.py --source 你的视频.mp4` 直接指定
- 确认文件未被占用，可用系统播放器先打开验证

**Web 监控黑屏或 FPS 很低**

- 确认已标定且 `/api/detect/status` 无 `error`
- 检查 YOLO 是否在 CPU 上运行（安装 GPU 版 PyTorch）
- 尝试 `detection.imgsz`、`skip_frames` 调优
- 主码流 1080p 解码 + 推理压力大，可试子码流

**画面延迟大**

- 优先排查 YOLO 推理与 RTSP 缓冲（已默认 `CAP_PROP_BUFFERSIZE=1`）
- Web MJPEG 比本地 `main.py` 窗口延迟更高，属正常现象

## 后续扩展

- 多摄像头统一到厂区坐标系
- 跨摄像头连续跟踪
- 告警规则（如距摄像头 < 3m 且靠近时触发）
- 对接平台 API / 事件订阅
