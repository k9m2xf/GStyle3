# GStyle3

把 iPhone 16 / 17 系列照片的**摄影风格 2** 升级到**摄影风格 3**，在「照片」App 里
解锁 **质感 / 胶片颗粒 / 光晕** 编辑，同时完整保留照片自带的风格 2 数据。

纯前端、零运行时依赖，全部处理在本机完成——照片和模型都不上传。

---

## 状态

本项目是**逆向研究**，下表如实区分「已在真机验证」与「仅容器级验证」。请以此为准，
不要把容器级验证当作功能可用。

| 能力 | 状态 | 验证层级 |
|---|---|---|
| 风格 3 编辑器入口（`texture_styles` 注入） | ✅ 可用 | 真机（iOS 27） |
| 质感 / 胶片颗粒 / 光晕（全局效果） | ✅ 可调 | 真机（iOS 27） |
| 12 张语义部件 matte 注入 | ✅ 容器结构与原生一致，掩码可解码 | 容器 |
| FSINC XMP sidecar 注入 | ✅ 与供体逐字节一致 | 容器 |
| MakerNote tag 84：`preset` / `grain` / `reversibility` 改写 | ✅ 等长原位改写 | 容器 |
| MakerNote tag 84：`intensity` 改写 | ❌ 需变长重建，见「已知限制」 | — |
| **柔肤（Soft 质感）** | ❌ **无法启用**，见下 | — |

### 关于柔肤

**柔肤不是靠掩码起作用的**，这个判断有明确的依据。

摄影风格 3 的质感家族由四层数据共同决定，本项目实现了第 1、2、4 层，
**第 3 层（People Data）没有实现，也无法通过容器注入实现**：

1. `texture_styles` 元数据项 —— 解锁编辑器入口。**已实现，真机验证。**
2. 12 张 FSINC 语义部件 matte —— 只定义作用**范围**，不含任何效果参数。**已实现。**
3. **People Data（MakerNote 内）** —— `canRenderTextureStylesOnComposition:` 以它为准，
   没有则整族质感都不渲染。逐脸记录 Face ROI / Face Skin ROI / Face ID / 姿态 /
   特征点，以及三个质感操作的统计量（Mattify、Skin Smoothing Standalone、
   Under Eye Brightening）和 `Instance Mask Reference Key`。**未实现。**
4. MakerNote tag 84 质感记录 —— preset / intensity / grain 等。**已实现读写。**

第 3 层是**拍摄时的逐脸神经输出**（平均脸色、皮肤粗糙度、人脸框与特征点），
掩码只回答"作用在哪"，不回答"作用成什么样"。要让 16/17 照片获得柔肤，
等于重新实现 Apple 采集管线的一段。详见 `README` 下文与 `docs/` 中的契约记录。

> 佐证：项目唯一的 18 Pro 供体是一张无人脸风景照，其 MakerNote 中
> `Face` / `Mattify` / `Skin` / `UnderEye` / `FSINC` / `Roughness` / `Texture`
> **全部不存在**——它连原生质感都渲染不了。同一批样本中，柔肤 0% 与 100% 的
> 导出件**逐字节相同**。

---

## 快速开始

### 网页版（默认路径）

需要一个静态服务器（`file://` 下 ES module 与 WASM 会被 CORS 拦住）：

```bash
python -m http.server -d . 8000
# 打开 http://localhost:8000
```

把 HEIC 拖进页面 → 下载 `IMG_E0001.HEIC` → 用**隔空投送 / 文件**传回 iPhone。

> ⚠️ 不要经「照片图库」共享回传，那会转码成 JPEG 并丢掉全部容器数据。

页面上的 **柔肤（实验性）** 复选框是掩码工作的总开关：关闭时不做任何分割。
非 Apple 平台的浏览器不支持在线 HEVC 编码，此时会显示手动载入掩码包的入口。

### 命令行

```bash
# 无头构建，不生成掩码包（使用照片自带的旧代皮肤掩码或空占位）
node tools/build.mjs IN.HEIC OUT.HEIC

# 先用 MediaPipe 生成真实掩码包，再注入
.venv/bin/python tools/make_masks.py PHOTO.HEIC out_masks/
node tools/build.mjs PHOTO.HEIC OUT.HEIC --masks=out_masks/mask-pack.json
```

### 质感记录读写

```bash
node tools/texturestyle.mjs PHOTO.HEIC                       # 只报告
node tools/texturestyle.mjs PHOTO.HEIC OUT.HEIC --preset=2   # 选柔肤
node tools/texturestyle.mjs PHOTO.HEIC OUT.HEIC --grain=0.5 --reversibility=1
```

---

## 工作原理

### 第 1 层：`texture_styles`

一个 `uri ` 元数据项，`item_name` 为 `metadata`，`cdsc → [主图, tmap]`，
载荷是 7 键 textureInfo bplist，必须位于 `mdat` 内：

```
Preset(str) CaptureType(str) CaptureMode(str) PortType(str)
HardwareModel(str) TextureStylePeopleDataVersion(int) FilmGrainSeed(int)
```

**这一项的存在就是风格 3 编辑器入口的开关**，与 People Data 无关。
本项目写出的内容与 iPhone 18 Pro 原生样张逐项一致（`FilmGrainSeed` 为每拍随机的值）。

### 第 2 层：12 张语义部件 matte + sidecar

`tag:apple.com,2026:photo:aux:semantic*`，12 个槽位：鼻 / 肤 v2 / 非脸肤 / 唇 /
牙 v2 / 人 / 眼镜 v2 / 眉 / 纹身 / 手 / 耳 / 脸肤。
URN 记录在 **`auxC` 属性**里（不在 infe 的 item_uri）。

每张 matte 还必须配一份 XMP sidecar（`mime` 项，application/rdf+xml，
`cdsc → 对应 matte`），内容是常量 357 B 的 `fsincMattes:FSINCMatteVersion = 0`。
**辅助图的解读完全依赖 sidecar**——没有它，Photos 根本不会解码掩码。
缺少 sidecar 的旧输出，重复运行会自动补齐。

原生规格（三张供体完全一致，本项目的命令行产线逐字节复现）：

| 项 | 值 |
|---|---|
| 尺寸 | 768 × 576 |
| `chromaFormat` | `0`（单色） |
| `pixi` | `0000000e 70697869 00000000 0108`，即一个 `(类型,位深)` 对 `(1,8)` |
| `level_idc` | `0x5a` |
| `lengthSizeMinusOne` | `3`（4 字节 NAL 长度） |

### 第 4 层：MakerNote tag 84 质感记录

真正选择质感风格的是 MakerNote 里嵌的一段 binary plist（Apple 二进制结构中
**没有可靠的 TLV 边界**，各条目前导字节无规律，因此按内容签名定位）。
实测值（iPhone 18 Pro 供体）：

| 键 | 含义 | 供体值 |
|---|---|---|
| `8` | preset：1=Standard **2=Soft 柔肤** 3=Studio 4=Filmic 5=Glowy | `1` |
| `9` | intensity（f32） | `1.0` |
| `10` | grain（f32） | `0.0` |
| `11` | originalInsteadOfReversibility | `false` |
| `12` | renderingVersion | `1` |
| `0`–`7` | info 字段（NeutrinoCore 校验，必填） | `1, -0.156, 0.0355, 1, 1, 1, 4, 0` |

键是**字符串**且写入顺序**非连续**（`10,2,3,11,4,5,12,6,7,0,8,1,9`），必须按名查找。

**改写全程等长。** bplist 共享取值相同的对象（`"8"`↔`"4"`、`"9"`↔`"3"`、
`"12"`↔`"0"` 各共用一个），直接覆写会连带改掉 info 那些必填字段。
工具的做法是：先在**字节完全相同**的另一个对象上安置 sharer，腾出原槽位再写新值。
供体里 `int 1` 有三个独立副本，所以 `preset` / `renderingVersion` 能这样改。

因为长度不变，**HEIC 容器不需要重建**——只在 Exif 条目的文件偏移处原位替换几个
字节，`iloc` 的 offset/length 依然有效。实测一张 4.8 MB 的照片只改 3 字节。

---

## 掩码产线

原生的部件 matte 是真实分割掩码。本项目提供三条产线，按优先级：

| 产线 | 平台 | 说明 |
|---|---|---|
| **1. 浏览器自动分析**（默认） | Safari / iOS / macOS | MediaPipe JS 人脸关键点 + DeepLab 人像分割 → 推导 12 张掩码 → WebCodecs 编码 HEVC。模型约 4 MB，按需从 CDN 加载。 |
| **2. 命令行掩码包** | 任意 | `make_masks.py`（MediaPipe + libx265 `gray`）产出 `mask-pack.json` 与 4×3 预览图，可肉眼核对后注入。 |
| **3. 旧代掩码移植** | 任意 | 把照片自带的 2019 `semanticskinmatte` 搬进 4 个皮肤槽位，其余用空占位。 |

诚实说明：

- 牙齿 = 口腔内部、眼镜 = 眼区带、耳朵 = 脸缘条带——**是有文档的近似**。
- 纹身 / 手部无检测器时**留空**，不伪造内容。
- 浏览器版没有手部检测器。
- **WebCodecs 没有单色 HEVC 模式**，浏览器产线只能出 4:2:0（`chromaFormat=1`），
  与原生的单色规格不同。命令行产线走 `gray`，头字段与原生逐字节一致。

> 三条产线都是**正确的底座**，但请注意：它们**不是柔肤的开关**，原因见「状态」。

---

## 目录结构

```
GStyle3/
├── index.html / app.js      网页界面（中文）
├── src/
│   ├── box.js               ISO-BMFF 基础读写
│   ├── items.js             项目图：iinf / iloc / iref / ipco / ipma
│   ├── bplist.js            bplist 写入器（含 real() 强制 f32）
│   ├── style3.js            风格 3 契约与注入
│   ├── landmarks.js         从人脸关键点推导部件掩码
│   ├── segment.js           MediaPipe 装载与调度
│   ├── hevcenc.js           WebCodecs HEVC 编码 + hvcC 构造
│   └── texturestyle.js      tag 84 质感记录的读 / 等长改写
└── tools/
    ├── build.mjs            无头注入
    ├── make_masks.py        掩码包生成
    └── texturestyle.mjs     质感记录 CLI
```

约 2400 行，`src/` 与 `tools/*.mjs` **零运行时依赖**，只用 Node 内置 API。

---

## 验证方法

本项目的每一条结论都经过至少两路独立验证，不接受自证：

| 层 | 方法 |
|---|---|
| 容器结构 | 读回注入后的条目，与 iPhone 18 Pro 供体逐字节对照 |
| bplist 语义 | 结果交由 Python `plistlib` **独立**解析复核 |
| 掩码可解码 | 编码 → 注入 → 读回 → PyAV 解码，尺寸与覆盖率须与输入一致 |
| 产物合法性 | `pillow-heif` 完整解码 |
| 真机行为 | iOS 27 实测，仅用于「状态」表中标注「真机」的两项 |

**自查 hvcC**：读回 matte 的 `hvcC`，确认 `[21]` 为 `0x0b`、`[22]` 为参数集个数、
每个数组头的 `numNalus` 为 1，再按 4 字节长度走一遍负载，应当正好走尽。
任一条不满足，Photos 会**静默丢弃**该掩码——症状与"掩码没内容"完全一致。

---

## 已知限制

- **柔肤无法启用**（缺 People Data，见「状态」）。
- `intensity` 无法等长改写：它的 real 取值对象没有字节相同的副本可借，腾空需要
  新增对象 → plist 变长 → 需重建 MakerNote 与 EXIF IFD 链。本项目未实现该路径。
- `upgrade()` **不覆盖照片中已存在的部件 matte**。因此给原生 18 Pro 照片使用时，
  它自带的空 matte 会被原样保留，掩码包不生效——该工具面向 16 / 17 照片。
- 只接受相机直出的 HEIC（窄 ipma、iref v0、iloc v0/v1），不处理 JPEG、动图。
- 掩码生成依赖 `.venv`（uv Python 3.12 + pillow-heif / mediapipe / av / numpy /
  scipy）；网页本体与 `tools/*.mjs` 无需这些依赖。

## 不做的事

- 不改写照片既有的风格状态（styles plist 的 `0` / `5` / `k` 键）——强制写入会重置调色板。
- 不伪造分割结果。
- 不上传照片或掩码到任何服务器。
- 不捆绑供体照片。

---

## 免责

本项目为个人技术研究与学习目的，非 Apple 官方项目，与 Apple 无任何关联。
它修改的是你自己拍摄的照片在自己设备上的显示效果。请遵守所在地法律法规，
不要用于商业分发或规避 Apple 的服务条款。
