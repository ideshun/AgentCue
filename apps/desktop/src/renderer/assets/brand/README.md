# 汇流 · 运行期品牌图标

来源：[image2 设计稿](../../../../../../docs/design/app-icon-v1/README.md)。PNG 直接复制已选设计的尺寸导出，保留透明通道；无运行期网络请求或图像转换依赖。

| 文件 | 像素 | 用途 |
| --- | --- | --- |
| `app-icon.png` / `app-icon@2x.png` | 512 / 1024 | 主窗口、macOS Dock、系统通知 |
| `brand-mark.png` / `brand-mark@2x.png` | 32 / 64 | 侧栏标识与 favicon；侧栏使用 2x srcset |
| `tray.png` / `tray@2x.png` | 16 / 32 | 托盘与高密度菜单栏图标 |

既有资源拷贝脚本将本目录分发到 `dist/renderer/assets/brand/`。主进程路径统一维护在 `src/main/branding.ts`，开发与打包模式共用；托盘的待介入数量和静音状态继续由现有标题、菜单表达。
