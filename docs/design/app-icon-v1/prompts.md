# image2 图标生成提示词

使用内置 `image_gen`（按本次 image2 请求），未调用 CLI/API。两次调用均使用真实透明背景；原始输出保留在本机生成记录，项目副本为 `master.png`。导出阶段只做缩放、PNG 编码和平台文件封装。

## 初稿

- 模式：生成新图，无参考图输入。
- 输出：`exec-00c96a9b-e1ef-4658-88cf-74664b6503d3.png`

```text
Use case: logo-brand.
Asset type: final production application icon for AI Workflow Monitor, a local-first desktop app that watches multiple AI coding tools, shows task progress, and gently calls the user back when approval or completion needs attention.
Primary request: Design ONE exceptionally polished, original, memorable app icon. Concept name: "Confluence / 汇流". Several task streams become one calm, readable place to look. One warm signal indicates the moment that needs human attention.
Visual concept: a compact, bold flowing emblem built from THREE broad rounded ribbon-like channels that join into one cohesive silhouette. They form a soft open window / abstract rounded W in negative space, with a small warm amber circular signal nested naturally in the upper-right opening. The dominant reading is a distinctive single icon, not a diagram. The emblem should feel stable, quietly alive, precise and approachable. Carefully art-direct the geometry, optical center, consistent rounded terminals, spacing and negative-space aperture. Use large shapes, substantial strokes and no tiny internal details.
Style reference principles: Google's clarity and purposeful color separation, Microsoft Edge's controlled flowing gradients, QQ and WeChat's friendly instantly recognized silhouette, Feishu/Lark's economical folded geometry, DeepSeek's confident single memorable symbol, ByteDance's compact visual rhythm. These are quality/style principles ONLY: create wholly original geometry. Do not depict, combine or imitate their logos, mascots, letterforms or signature silhouettes.
Color palette: main flowing mark transitions elegantly from saturated cobalt blue (#3867EF) through deep clean teal (#087F8C) into a restrained fresh jade (#39CDA3), with crisp distinct overlapping regions and an intentional light/dark contrast. Only ONE small warm amber (#FFBC55) signal; it is part of the identity, not a warning badge. Background tile is very light warm porcelain (#F8FAF7). Let the silhouette carry recognition even without gradients.
Composition/framing: one centered front-facing square app icon on a genuine alpha-transparent canvas. A precisely drawn rounded-square/squircle porcelain tile occupies about 86% of the square, leaving even transparent margins; the bold emblem occupies about 65% of the full canvas, centered optically with generous coherent safe space inside tile. The amber point must remain within the icon safe zone. Very subtle tile-edge depth only, flat vector-like shapes, smooth clean antialiasing, extremely restrained ambient shadow, no visible texture. Polished enough to sit beside Google, Edge, WeChat, Feishu and DeepSeek in a real desktop dock.
Multi-size constraints: strong silhouette and open negative spaces at 16, 24, 32, 64, 128 and 512px; eliminate micro-details and delicate strokes. Sympathetic to light and dark desktops, Windows/Linux square icons and macOS rounded tiles.
Text: NONE. No AWM, no letters rendered as text, no brand name, no Chinese, no caption.
Deliverable: ONLY the single finished icon, large square, centered, sharp, true transparent surrounding background. Not a presentation board, not a grid of options, not an app screenshot, not a laptop/phone mockup.
Avoid: brains, robots, eyes, CCTV, binoculars, generic bells, literal sound waves, checkmark-in-circle, four-point AI sparkle, dashboards, chairs, desks, gear wheels, tiny workflow nodes, rainbow collage, glass/plastic 3D effects, metallic bevels, dramatic lighting, perspective tilt, noisy gradients, background scenery, watermarks.
```

## 最终稿

- 模式：编辑初稿。
- 编辑目标：`exec-00c96a9b-e1ef-4658-88cf-74664b6503d3.png`
- 输出：`exec-1ec51508-eb65-44b4-bf01-4e312c245664.png`
- 默认原始文件目录：`<local image-generation cache>/`

```text
Use case: precise-object-edit.
Asset type: final production application icon refinement, not a concept board.
Input: the single attached icon is the EDIT TARGET. Keep the existing original "Confluence / 汇流" identity: cobalt left ribbon, deep teal upper channel, jade right ribbon, connected soft W silhouette, white central aperture, and warm amber attention dot on a light porcelain rounded-square tile.
Change ONLY these production details:
1) Reduce the amber circle diameter about 12 percent while preserving its center. Maintain a clearly open gap to the jade ribbon so the dot remains separate at 24 and 32px. It should feel like a calm signal, not a large sun or a notification badge.
2) Make the tile outer contour perfectly smooth and even. Remove ALL stray white specks, frayed pixels, rough halo and detached marks outside the tile. All surrounding canvas must be true transparent alpha, with no stray particles. Keep at most a very restrained clean tile-edge shadow, no floating exterior shadow smudges.
3) Slightly simplify the gradient transitions into broad smooth controlled regions, preserving contrast between the overlapping cobalt, teal and jade surfaces. Keep the center aperture wide and clean. Do not add more colors, details, glare, reflections or depth.
Invariants: exact overall composition, one centered icon, tile size about86percent canvas, emblem proportions/geometry and optical center, front-on view, square canvas. No new elements or text, no labels, no marketing mockup, no perspective, no device, no branding from any existing app. Premium vector-like polish, strong16–512px legibility. Genuine transparent background outside the tile.
```
