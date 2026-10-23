/**
 * 主窗口管理（P3 渲染进程宿主）。
 *
 * 行为约定：
 * - 关闭窗口不退出应用（菜单栏常驻），只隐藏
 * - 真正退出走托盘「退出」或 Cmd+Q，由主进程置 quitting 标记后放行 close
 */
import path from 'node:path';
import { BrowserWindow, nativeTheme, shell } from 'electron';

/** 窗口单例 */
let mainWindow: BrowserWindow | null = null;

/** 是否处于真正退出流程 */
let quitting = false;

/** 关闭前询问渲染层（是否有未保存设置）；null 表示直接隐藏。 */
let closeDecision: (() => Promise<boolean>) | null = null;

/** 正在等待用户选择关闭方式，重复点击红点不叠加询问。 */
let askingClose = false;

/**
 * 标记进入退出流程，放行窗口 close 事件。
 */
export function markQuitting(): void {
  quitting = true;
}

/**
 * 注册关闭前的确认回调；返回 true 才隐藏窗口。
 * @param handler 询问渲染层
 */
export function setCloseDecision(handler: () => Promise<boolean>): void {
  closeDecision = handler;
}

/**
 * 创建主窗口。
 * @returns 主窗口实例
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'AI Workflow Monitor',
    // 与渲染层 --bg 对齐，避免深色模式下隐藏窗口恢复时闪浅色底
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0e12' : '#f5f6f8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('close', (event) => {
    // 真正退出时放行；否则先问渲染层有没有未保存的设置，再决定是否隐藏。
    if (quitting) return;
    event.preventDefault();
    if (askingClose) return;
    askingClose = true;
    void (async () => {
      try {
        const proceed = closeDecision ? await closeDecision() : true;
        if (proceed && !quitting) window.hide();
      } finally {
        askingClose = false;
      }
    })();
  });

  // 外部链接交给系统浏览器，禁止在应用内打开
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void window.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  return window;
}

/**
 * 显示并聚焦主窗口；窗口已销毁时重建。
 */
export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 获取主窗口。
 * @returns 主窗口实例，不存在返回 null
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * 向渲染层推送刷新信号。
 * @param channel 通道名
 * @param payload 载荷
 */
export function sendToRenderer(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
