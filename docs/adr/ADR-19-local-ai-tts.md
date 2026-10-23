# ADR-19 本地 AI 语音（Kokoro via sherpa-onnx）

> 对应功能：播报后端新增「本地 Kokoro」；系统原生音色从 Sinji-only 放开为中文白名单。

## 背景

用户反馈播报"只有本地能用、音色只有一个粤语"。诊断：`packages/core/src/voice/tts.ts`
曾把 `listNativeVoices()` 硬过滤为 Sinji/zh_HK 一个音色，且 macOS 播放路径无视
`voiceProfile` 强制回落善怡；本地 AI 与云后端均为 stub。macOS 本机实有 20+ 中文音色
（经典款随系统安装，Sequoia 增强款需在系统语音设置下载）。同时，系统原生中文音色质量
参差，需要一个真正可用的本地 AI 引擎。

## 决策

1. **系统音色放开为白名单**（`NATIVE_VOICE_ALLOWLIST`）：善怡（粤）、婷婷（普）两款经典 +
   Shelley/Sandy/Reed/Rocko/Eddy/Flo 六款增强（不含 Grandma/Grandpa），另有
   Samantha/Alex/Daniel/Karen/Moira/Tessa/Rishi/Aman 等常用英文音色；自动优先级按数组顺序。
   保存的音色命中白名单直通，未命中回落自动。增强款只放行 `zh_CN`——曾放行 `zh_TW` 并按
   语区加「台湾」标签，实测这些音色读中文比普通话款更差，且放开港台音色不是本功能的目标
   （要港台腔应调研专门的 TTS，而不是把本地引擎的语区标签放出来）；美佳（台）仍作为经典
   音色保留，但不参与自动优先级。自动播报只在中文音色里兜底，英文音色必须用户显式选择。
2. **本地引擎选 Kokoro v1.1**（`sherpa-onnx-node`，Apache-2.0）：中英混读、数字/日期
   归一化内置、CPU 实时率足够、103 发音人（中文女声 55 / 男声 45 / 英语 3：
   `af_maple`、`af_sol`、`bf_vale`）。对比落选：
   Piper（GPL-3 代码基与社区维护不确定性、中文包质量一般）、Python 路线（违反本地优先
   的零额外运行时原则）。引擎模型包 `kokoro-multi-lang-v1_1` 约 348MB。
3. **依赖落 `apps/desktop`，不进 core**：core 保持零原生依赖（先例：better-sqlite3 在
   store）。`sherpa-tts.ts` 实现 core 的 `TtsBackend` 接口，`tts-chain.ts` 装配。
4. **下载 = 用户显式动作**（C-01 合规）：默认不下载、不出网；设置页明确说明大小与来源；
   失败置 error 态、由用户手动重试，不自动重试。模型状态瞬态，走
   `GET /api/v1/voice/model` + `model.progress` SSE，不进 settings.json。
5. **`voice.backend` 枚举追加 `'local'`**；旧值 `'piper'` 保留为不可用状态。播放器严格遵守
   所选后端：Kokoro 模型、运行时或播放失败时返回具体错误，由自动播报通知用户；试听不切换
   系统音色。音色复用自由字符串 `voice.voiceProfile`，Kokoro 值为 `kokoro:<sid>`。
6. **试听文本统一截 200 字**（原 API/IPC 两处 500）：长文本生成+播放远超 30 秒播放
   超时——这是修复 native 路径既有的踩坑，属行为变更。
7. **中文词级读音覆盖**：在模型原词典之前加载 24 个开发语境里必读 chóng 的词（重构、
   重试、重写、重命名、重编译、重排等），从模型自带同音字词条取音素，初始化后删除临时词典
   （sherpa 在引擎初始化时已读入覆盖文件，删除不影响结果）。基础词典缺这些词时单字「重」
   默认读 zhòng，实测“重构”的“构”直接没有声音；波形 A/B 比对确认覆盖后整词发音正确。
   后缀字在词典缺失时只跳过该词，不让整套本地播报启动失败。不改播报原文或模型文件，
   不全局替换“重”的读音；有歧义的词（重载 zài、重用 zhòngyòng）有意交给原词典判断。
8. **音色辨识**：按官方 sid 映射展示 `zf_001` / `zm_009` 等真实代码；用户试听后自行
   命名并加入常用，保存到 `voice.savedVoices`。全部 100 个中文音色始终可直接选择，
   常用音色只置顶、不折叠或过滤其余音色。模型未提供可靠的音色风格标签，界面不预设音质或
   风格结论。修改名称不打断播放。

## 影响

- **无官方 sha256**：模型包完整性只能靠"必需文件存在 + 最小尺寸"校验与 tar 解压结果；
  上游 release 未提供校验和，已逐文件比对 HF 镜像大小一致。风险接受并记录。
- **下载断点续传**：`.part` 失败/取消后保留，重试带 `Range` 头（206 续传；200 不支持则
  作废重下；416 越界作废重下）。实测源（HF mirror / GitHub Azure Blob）均支持 Range。
- **手动放置**：`status()` 对磁盘目录实况探测，用户自行下载
  `kokoro-multi-lang-v1_1` 解压到 `userData/models/` 即显示 ready，无需应用内下载。
- **GitHub 源国内失败率高**：L2 实测本机 GitHub 资产 CDN GET 吞吐为 0（HEAD 可达）。
  当前代码固定 GitHub 直链；`hf-mirror.com/csukuangfj/kokoro-multi-lang-v1_1` 逐文件
  镜像实测约 3.5MB/s 可用，**镜像源尚未实现为可选项**（计划中为"预留"）。
- **安装包缺运行时**：pnpm 10 hoisted 布局下 electron-builder 将 workspace 包放入 asar，
  但没有包含根 `node_modules` 下的第三方 `sherpa-onnx-node` 与平台原生包。模型文件仍可显示
  ready，试听却在动态加载时报模块缺失；旧链路随后把 Kokoro 音色编号交给 macOS `say`，
  最终听到默认善怡。现由 `afterPack` 按目标平台与架构复制 JS 包及原生包到
  `Contents/Resources/sherpa-tts/node_modules`，主进程以该资源目录创建 require；试听失败时
  显示错误，不再静默换音色。已用 Electron 44 ARM64 Node 模式加载打包资源中的
  sherpa-onnx-node 1.13.8（无模型初始化、无音频），并检查原生 `.node` 与三份 dylib 都入包。
  本机未安装 sherpa x64 可选包，因此本轮只打出并验证 ARM64 包；其他架构必须有相应可选包。
- **取消与超时**：`generateAsync` 无 signal——经 `onProgress` 检查 abort 返回 false 早停
  （句间粒度）；合成包 120s 超时 reject，避免 onnxruntime 挂死卡住串行播放链。
- 增强款音色与 Kokoro 中文质量（CER ~4%）需用户试听定夺；白名单一行可删。
- **Kokoro 无粤语、无台湾语区**：upstream `Kokoro-82M-v1.1-zh` 的 100 个中文发音人只有
  普通话，`z` 前缀在 VOICES.md 中即指普通话。需要粤语或台湾语区音色只能走系统原生；
  界面已在本地音色列表下方明示。曾评估的候选：sherpa-onnx 侧唯一的粤语模型
  `vits-cantonese-hf-xiaomaiiwn`（103MB / 22.05kHz / yue 标签）权重许可未声明，
  不引入；`Luigi/matcha-zh-tw-en-8k` 作者自述只修正字音、腔调仍是大陆普通话且仅 8kHz。
- win/linux 新增 `playAudioFile` 播放路径无测试覆盖（原生播报路径不动）。

## 回滚成本

低。引擎后端与白名单相互独立：删 `tts-chain.ts` 的 local 分支即回纯原生；白名单数组
收缩回 Sinji 单项即恢复旧行为（renderer 与服务端共用同一份枚举语义）。
