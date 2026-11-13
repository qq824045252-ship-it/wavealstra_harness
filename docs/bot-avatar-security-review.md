# 头像上传容器预检安全修复（独立候选 v2）

旧交接补丁 `bot-avatars-from-6072ad6a.patch` / `bot-avatars-review-overlay.zip` 存在 WebP 解码前尺寸绕过，不能合入。本次候选保留同一 main 基线和全部 93 只正式资源，只修头像安全与相关测试/构建。没有提交、推送，也没有覆盖本地 Work UI 或编排。

## 红灯证据

先加入并运行 `pnpm -s test:bot-avatar-containers`，然后才修改校验器。自制 `fixtures/bot-avatars/webp-large-first-small-last.webp` 为 738 字节，与复审报告的 1194 字节原件属于同类复现，未声称使用了原件。

```text
real decoder: { width: 4096, height: 4096 }
old preflight: { type: "webp", width: 128, height: 128, frames: 1, durationMs: 0 }
AssertionError: Missing expected exception:
Ambiguous WebP must be rejected before native/WASM decoding
```

原始红灯日志：`out/tests/bot-avatar-container-red.log`。测试使用真实 Photon/WASM 的独立测试 Worker 读取原始像素尺寸，不靠伪解码器或仅断言源码。该原始探针不导出到产品，没有提供绕过预检的产品接口。

## 解码前修复

`src/shared/bot-avatar-raster.ts`：

- WebP 不再循环覆盖 width/height。只允许一个 VP8 或 VP8L 图像块，逐个在读到对应头时检查其自身尺寸；混合或重复图像块即使尺寸相同也拒绝。
- VP8X 必须唯一且是首块，长度与保留位必须有效；画布和实际位流尺寸都分别受预算约束，随后要求完全一致。拒绝迟到的画布、缺图像块、动画标记及不支持的歧义容器。
- RIFF 长度、逐块边界、奇数字节填充、VP8/VP8L 头、VP8L 版本、ALPH/ICCP 顺序、元数据声明/重复与一致性均检查。已知静态 VP8、VP8L、VP8X、alpha 与元数据仍可用；这个头像接收配置有意拒绝未知 chunk，范围比通用 WebP reader 更窄。
- PNG 检查每块 CRC、唯一首个 IHDR、格式、调色板/透明块、连续 IDAT、有效 IEND 与无尾随数据；拒绝 APNG 和重复/矛盾头及未知关键块。
- GIF 在逻辑画布和每一帧处校验尺寸、帧边界、调色板、控制块、LZW 子块和累计资源预算；拒绝重复/畸形控制、截断、尾随容器、帧数/像素/时长超限。正常 PNG/GIF 以及清理后动画 poster 均覆盖。
- JPEG 完整扫描段和扫描边界，支持正常基线/渐进 JPEG，拒绝重复 SOF、改变尺寸的歧义标记和尾随图像。

`src/main/agent/work/bot-avatar-image-worker.mjs` 在自己的预检通过后才动态加载 Photon，再调用图片解码。主进程已拒绝的上传不会启动 normalizer；直接给 Worker 发送畸形字节也只得到 `invalid_container`，不会加载并解码攻击图片。

## 实际 WASM 内存上限

Node `resourceLimits` 约束 V8 堆，不能当作 WASM 内存沙箱。因此新增 `scripts/avatar-wasm-memory-limit.mjs`：为头像独立复制的 Photon wasm32 模块设置 **2048 pages = 128 MiB** 的线性内存 maximum。只接受一个未共享的 wasm32 memory；验证 WASM 模块、禁止额外/导入 memory，布局不符时构建失败。

`build-bot-avatar-image-assets.mjs` 仅将头像 Worker 的 Photon 加载器绑定到 `bot-avatar-photon.wasm`，且未应用绑定时构建失败。其他 Pi Worker 和原有 `photon_rs_bg.wasm` 不变。不新增图像依赖。新增 WASM 与头像 Worker 均有 asarUnpack 配置。

测试实际实例化这份受限 WASM，尝试超过 128 MiB 的 `memory.grow()`，确认抛出 RangeError 且内存大小不变；随后正常解码仍成功。2048×2048 正常 PNG 在该限制下缩成合规 poster。这个数字只指 WASM 线性内存，不是整个进程 RSS；V8、线程、代码等开销另算。压缩数据本身仍由成熟解码器在该上限和既有超时内处理，结构预检不声称验证全部压缩位流。

## 验证

- 红灯先失败，修复后同一真实解码测试转绿。
- `test:bot-avatar-containers`：**44** 个负例，在主进程和真实产品 Worker 内均拒绝；覆盖多/混合图像块、矛盾 VP8X、坏长度/填充/标记/元数据、PNG 重复头/CRC/APNG/截断、GIF 帧/控制/像素/帧数/时长；另有正常 lossless/lossy-alpha/extended WebP、PNG、GIF、渐进 JPEG、2048² PNG、清理后 poster 与真实 WASM 内存上限。
- `test:bot-avatar-decoder`、`test:bot-avatar-assets`、`test:bot-avatars`、`test:bot-avatar-ui` 全部通过。上传服务测试明确断言攻击文件进入 normalizer 的次数为 0，超限 poster 不写入持久存储。
- `pnpm -s typecheck` 与测试分类 audit 通过；未修改测试失败基线。headless 当前分类为 532 项，只运行本次相关专项，未声称全量通过。
- 原有 93 只素材的哈希、186 个资源文件、28,657,002 bytes 和 6 个排除编号均保持不变。

集中日志与逐项退出码：`out/tests/bot-avatar-security-review/`。Worker 改为预检后延迟加载 Photon 后，containers 与 decoder 又分别通过。

未测：真实 Electron 原生 picker 联调、Windows/macOS/Linux 桌面行为、发行包/asar 内新 WASM 与 Worker 的实际加载、全量 headless/GUI/NETWORK、系统级总 RSS/CPU 压测或任意畸形压缩流的全面模糊测试。本次没有 build/pack/dist，没有推送。渲染界面未改变，保留先前已说明边界的独立浏览器预览结果，不将其算作原生 Electron 安全验收。

规范依据：[WebP 容器规范](https://developers.google.com/speed/webp/docs/riff_container)、[WebP lossless 位流规范](https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification)。实现使用更保守的头像接收配置，不把一般 reader 的宽容解析行为当作安全依据。
