# 应用图标

`icon.icns` 与 `icon.ico` 使用「汇流」设计稿的原始平台导出，来源见 [设计说明](../../../docs/design/app-icon-v1/README.md)。

- `electron-builder.yml` 将它们分别作为 macOS 与 Windows 的应用图标。
- Linux 使用 `src/renderer/assets/brand/app-icon.png`（512px）。
- 主窗口、macOS Dock、系统通知、托盘与界面标识使用 [运行期品牌资源](../src/renderer/assets/brand/README.md)。

更新设计时同步替换平台文件与运行期 PNG。安装后的系统图标来自构建应用包，修改源码后需要重新打包；开发模式重新启动主进程后加载新资源。

## Electron 许可文件

`licenses/` 中的 Electron MIT 许可和 Chromium notices 来自根 `package.json` 锁定的 Electron **44.9.0** 分发包。升级 Electron 时须同步更新；Chromium 完整 HTML 以 gzip 无损压缩，打包时原样放入应用资源。
