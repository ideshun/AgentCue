# 办公室插画与图标资源

## 当前使用素材

- 2026-10-26 使用内置 `image_gen` 编辑现有插画（imagegen 技能内置模式，未使用 CLI）。
- 四组员工形象按工具 ID 稳定分配，刷新、筛选或顺序变化不会重新随机；未安装工具使用空工位。CodeX CLI 与 Cline 共用沙漏搭配。
- 当前实际引用下列五张 1254 × 1254 WebP，均保留透明通道，合计 1,248,908 字节（约 1.19 MiB）。旧版素材不再由 `officeDeskArt` 选择。
- 桌面没有工牌；真实工具图标由原生 SVG 投影到插画原有的椅背小贴标，不新增底板。图标跟随贴标的水平斜边与椅背后倾方向，在 280px 工位上约 11px；相对上一版居中放大 12%，投影角度不变。未知工具使用名称。
- 原始编辑目标及输出 PNG 保留在本机生成记录 `本机图像生成缓存（原始输出）`，项目中的最终资源见下表。

| 搭配 | 文件 | 字节 | SHA-256 |
| --- | --- | --- | --- |
| 书本 / 水杯 | `desk-books-v5.webp` | 258276 | `1208b584effc5d8ff3d4d57b5e11df894fc92fbe3fe7e5f799b14e3f7724c0a8` |
| 彩铅 / 猫摆件 | `desk-creative-v5.webp` | 255022 | `44c2db68ce83b24c4a4f3e3658813c624005074fc3b9990202bae9b15cd88468` |
| 耳机 / 保温杯 | `desk-tech-v7.webp` | 244314 | `44cf68ffa7090e21523685867931a326c9de8c3d24d960faf4544432df145474` |
| 沙漏 / 木鸟 | `desk-focus-v6.webp` | 296160 | `209d5ca55dfd54bd98d43b436124d641d1ab755bc432c4e689a42335a922f1c1` |
| 空工位 | `desk-empty-v4.webp` | 195136 | `43dc86083714c172959c4a616c3a15be0b0011ba20745e4a69c780a9780b70d0` |

## 摆放与比例

- 键盘、鼠标及员工伸手区域优先留空；本子在可书写、查看的右侧区域，CodeBuddy 的本子沿桌面转为竖向，装订边朝远端。
- 水杯改为低矮杯型，高度低于笔长，并移到鼠标右后方的桌内区域；书本、笔和摆件与桌沿保持可见留空。
- CodeX CLI / Cline 的沙漏和本子分离；木鸟缩小并向内移。
- Cursor 耳机位于右后侧，保温杯位于其前侧；杯高略低于上一版。无线充电座位于显示器下方、支架右侧，鼠标右侧活动区留空。
- 充电线从充电座插口连续接到显示器后方，不保留旧位置的悬空线段。实物与屏幕绘制区域分离，不用屏幕内容遮盖物品。
- 提示词中的厘米数为插画的比例参考，不代表对位图进行物理测量。最终需按工位尺寸检查实际视觉比例、桌沿净空和遮挡。

## 真实工具图标

图标使用真实品牌资源；Claude Code 按橙底白芯样式重制为 SVG，白芯轮廓来自 [Claude 官网](https://claude.com/) 内联的 `ClaudeWordmark` 标志路径。画布为 256 × 256，橙色圆角底为 `#D97757`，白芯按 180 × 180 居中，四边留白均为 38；参考截图仅用于样式比对。其余图标来自官网或官方发布页。商标与图标权利归各自权利人，用于识别对应工具。API 提供真实图标时优先采用；未知工具只显示名称，不补造图标。

| 文件 | 来源页 | 原始资源 | SHA-256 |
| --- | --- | --- | --- |
| `icons/codex.png` | [CodeX CLI](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) | [原图](https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.51021.22027/1792788319200/Microsoft.VisualStudio.Services.Icons.Default) | `2ce1c57dd3b312417106a487815ab1235bddce17e1fa9b32a2f048bd71ee25d3` |
| `icons/cursor.svg` | [Cursor](https://cursor.com/brand) | [原图](https://cursor.com/marketing-static/favicon-light.svg) | `78f169abca311d70e18ada789ccf1a55b4ca0306822f21a9ab0c2658ed88dbe0` |
| `icons/claude-code-orange.svg` | [Claude 官网](https://claude.com/) 标志轮廓，橙底白芯矢量重制 | 2026-10-26 提取官网内联 SVG 的白芯路径，重建圆角底与居中留白 | `d26f90102a862481a1d4f117ec903192d809c24c9db51f1aaf28dace2822cbce` |
| `icons/cline.svg` | [Cline](https://cline.bot/) | [原图](https://cline.bot/assets/branding/logos/cline-icon-dark.svg) | `a34dcb49437c420e107c986e1e63b721d64843e82238ba0c43786447c92e0589` |
| `icons/codebuddy.svg` | [CodeBuddy](https://codebuddy.ai/) | [原图](https://codebuddy-1328495429.cos.accelerate.myqcloud.com/web/ide/logo.svg) | `149baa45b9f9370c15f20d599afe381aa138e4fc13acf503f435c571ac93ecf5` |

## 最终编辑提示词（原文）

每张素材独立调用内置工具。以下为最终选用图对应的最后一次编辑；中间稿保留于生成记录，不被页面选择。表内目标与输出文件位于上面的本机生成目录。

### 书本 / 水杯 · desk-books-v5.webp

- 编辑目标：`exec-994c4c55-69d9-4681-b719-9cca6e25e2b5.png`
- 最终输出：`exec-7d583ba7-3fba-48bb-b5f0-ce29a878588c.png`

```text
Use case: precise-object-edit. Single input is EDIT TARGET. Fix ONLY glass, books and pencil; everything else pixel aligned.
MOST IMPORTANT: the glass is still too tall and dangerously near the FRONT edge. REMOVE it from its present location. It must be a short low tumbler 9 cm tall and 6 cm diameter, not a tall drinking glass. Pencil is 15 cm long: pencil must look clearly LONGER than the glass's VERTICAL height. Glass visible height should be about half the pencil visible length.
Relocate the smaller glass UPWARD/BACKWARD on the tabletop to immediately right of mouse but slightly BEHIND the mouse, not toward viewer. On a normalized 1280x1280 image, aim glass support BASE near (910,625), top around y550, rather than current base near y720. This is a move by about 90 image pixels away from the front edge. Leave a broad obvious stripe of bare oak, at least about 10cm or a full cup diameter, between glass base and ALL nearest table edges. Keep a clear gap from mouse, pencil, notebook stack. Glass is off the keyboard/mouse sweep area and cannot spill directly on keyboard.
Two notebooks should be compact A6 sized (roughly 11x15 cm), about 20 percent smaller than current stack, located safely inboard in right storage zone around (1050,575), entirely supported with wood clearance to back/right edges. A normal 15 cm pencil lies to their near side, between books and front edge but well inside the tabletop (around x1000,y640), never balancing along rim.
Do not keep the current front-edge cup location. Do not enlarge cup or notebooks. Preserve exact employee/body/chair blank sticker/monitor blank white screen/desk/keyboard/mouse/camera/framing/lighting/materials, true alpha background and contact shadow. No new props/text/logos. Premium detailed 3D chibi.
```

### 彩铅 / 猫摆件 · desk-creative-v5.webp

- 编辑目标：`exec-e07a41c5-69da-40ac-b297-f0f177096ff6.png`
- 最终输出：`exec-2d8847b7-fd59-4568-8e88-a8c03ac8a6b6.png`

```text
Use case: precise-object-edit. Single input is EDIT TARGET. Refine ONLY the notebook, cat and pencil-holder to be safely placed like a real workspace, preserving the existing portrait notebook rotation.
Keep the notepad rotated 90 degrees relative to the old landscape pad: its long axis follows table depth, short top edge with spiral binding points away from employee, bottom edge toward employee for writing. It should be compact A6, 10.5x14.8 cm. Move it BACKWARD/INWARD from its current near-edge position, leaving a broad visible strip of wood (8–10cm) between pad and front/right boundaries. Keep practical mouse movement gap and room to write. The page must remain upright from the employee's viewpoint.
Pencil holder is small, with normal pencils 15cm long, not huge rods; the ceramic cat is a tiny 6cm desk figurine, shorter than pencils. Move both safely inboard away from rear/right rims, reducing decorative object scale about 15 percent if needed. Their whole footprint must have visible tabletop all around and at least 8–10cm nearest-edge clearance. Adjust the three positions as a coherent right-side desk arrangement, no touching or interpenetrating props. Keep all tall props clear of monitor silhouette and screen. Do not merely shift all props towards another edge.
Everything else must be pixel-aligned and unchanged: employee identity/lavender clothes/natural feet-on-floor posture, head, desk/chair/small blank sticker, monitor/blank white screen/keyboard/mouse, camera/framing/margins, finely textured 3D chibi style, illumination, real transparent alpha and contact shadows. No additional items, text, logos or desktop badge.
```

### 耳机 / 保温杯 · desk-tech-v7.webp

- 编辑目标：`exec-82e08852-b739-465c-b26a-c1f9c6235d0b.png`
- 最终输出：`exec-4b9c5ec1-2f60-43f6-8370-2a90c05fb717.png`

```text
Use case: precise-object-edit. Single input is EDIT TARGET. Apply these small realistic desk refinements only.
1. MOVE the wireless charging puck AWAY from beside mouse. Place it further BACK, DIRECTLY UNDER THE MONITOR, in the clear space just to the RIGHT of monitor stand base, below screen's bottom-right corner. On normalized1280 square aim puck center roughly(910,547), not its current(905,632). Its full small round footprint is flat on wood and visible, separate from stand with a modest gap. Keep the puck compact at 9cm diameter. The entire mouse/right-hand sweep area in foreground must now be empty oak. Keep ONE continuous short black USB cable physically attached at puck rear socket/connector and routed backward behind monitor stand. Erase its old long cable and former puck location completely, restoring oak. No broken cable, stubs or floating ends, nothing crossing mouse area or white screen.
2. Thermos is now slightly TOO TALL. Reduce ONLY its vertical height by approximately TEN PERCENT, keeping diameter and recognizable silver thermos form unchanged; do NOT shrink into a vial or grow into a huge bottle again. Shorten gently around its base. A medium500ml bottle, around21–22cm tall, still clearly taller than charging-pad diameter. Keep whole bottle to right of monitor bezel with a visible gap. Base safely supported inward from nearest table edge, a clear wood strip of about one base diameter.
3. Headphones stay behind/right of thermos, but move their footprint a little LEFT and BACKWARD from the right/front rim, around40px left and20px up on normalized1280 canvas. Show tabletop outside the headphones footprint so they cannot fall. Correct natural perspective occlusion from the thermos in front is fine; no interpenetration, no resting on a rim.
Everything else MUST stay pixel-aligned: employee, identity/clothing, desk/chair and blank sticker, monitor/screen/stand/keyboard/mouse, camera/framing/margins and finely detailed soft3D chibi materials/light. The screen stays blank white at original coordinates. No new items/text/logos. Preserve genuine transparent alpha and soft shadows.
```

### 沙漏 / 木鸟 · desk-focus-v6.webp

- 编辑目标：`exec-e910eff1-4b6f-4f1e-b635-1446d83f71cd.png`
- 最终输出：`exec-ef87f28c-5de2-4e40-91fb-e41a47281746.png`

```text
Use case: precise-object-edit. Single input is EDIT TARGET. Change ONLY the wooden bird: currently too near front/right edge. Make it a tiny 6–7 cm wooden desk figurine, about 25 percent smaller. Move it BACKWARD and slightly LEFT/INWARD so its entire base has a broad band of visible bare wood, at least about 8–10 cm, to the front/right desk boundary. On normalized 1280 square, aim bird base near (1030,655) instead of current near (1045,705). Keep the bird clearly separated from notebook and hourglass, not touching or overlapping their bases, and keep mouse area empty. Do not put it on an edge.
Keep hourglass and notebook current small practical proportions and separated positions, all other pixels unchanged including blank screen/monitor/furniture/employee/chair/small sticker/camera/framing/transparent alpha/lighting and detailed premium 3D chibi style. No new accessories/text/logos.
```

### 空工位 · desk-empty-v4.webp

- 编辑目标：`exec-7d583ba7-3fba-48bb-b5f0-ce29a878588c.png`
- 最终输出：`exec-b8b02643-02f0-4331-9f7b-f636ab8e083e.png`

```text
Use case: precise-object-edit. Single input is EDIT TARGET. Remove ONLY the entire human employee (head, clothes, arms, hands, legs and shoes) to produce the matching empty workstation, revealing empty chair seat naturally. Do not move or resize anything else. Preserve the exact blank sticker on chair back, table/chair/monitor/stand/keyboard/mouse geometry and blank screen, camera/framing/margins and all three right-side accessories with their corrected real proportions and safe inward locations: low short water tumbler9cm high behind/right of mouse, compact two-book stack, pencil15cm long (visibly longer than glass height). Do not move cup back near front edge. Keep original oak clearance around every object. No new objects, no text or logos, no desk badge. Same premium finely textured soft3D chibi rendering, illumination, true alpha-transparent background and subtle alpha contact shadows.
```


## 渲染与构建约定

- 不通过整图位移伪装人物动作；屏幕光标动效由真实状态驱动。
- `officeDeskArt` 的 SVG 仅承载裁剪后的屏幕图案、椅背贴标与真实图标（或未知工具名）。替换素材后检查屏幕裁剪及贴标坐标。
- 工位最大宽度 280px，网格横向间距 28px、行间距 8px；气泡预留高度 96px，较旧版收紧。单项筛选不放大工位。
- 消息气泡和详情浮窗均可关闭，同一任务/状态的关闭记录跨刷新保留；新任务或状态变化重新提示。
- `copy-assets.mjs` 将本地资源复制至 `dist/renderer/assets/office/`，安装后离线使用。
