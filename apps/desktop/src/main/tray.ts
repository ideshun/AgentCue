/**
 * 菜单栏托盘（P1 主进程）。
 *
 * 状态表达：macOS 用托盘标题显示待介入数量（如「2」），全局静音时显示「静音」角标；
 * Windows/Linux 无 setTitle，改为在菜单首行文字里体现。
 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { APP_DISPLAY_NAME } from '@awm/core';
import { TRAY_ICON_PATH } from './branding';

/** 托盘动作 */
export interface TrayActions {
  /** 打开主窗口 */
  onOpen: () => void;
  /** 扫描工具安装清单 */
  onScan: () => void;
  /** 切换全局静音 */
  onToggleMute: () => void;
  /** 退出应用 */
  onQuit: () => void;
}

/** 托盘展示状态 */
export interface TrayStatus {
  /** 待用户介入数量 */
  attention: number;
  /** 运行中的会话数 */
  running: number;
  /** 是否全局静音 */
  muted: boolean;
  /** 最近扫描时间（ISO 8601） */
  lastScanAt?: string | null;
}

/** 托盘句柄 */
export interface TrayHandle {
  /** 托盘实例 */
  tray: Tray;
  /**
   * 更新展示状态并重建菜单。
   * @param status 状态
   */
  update: (status: TrayStatus) => void;
}

/**
 * 创建托盘图标与菜单。
 * @param actions 交互回调
 * @returns 托盘句柄
 */
export function createTray(actions: TrayActions): TrayHandle {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  const tray = new Tray(icon);
  tray.setToolTip(APP_DISPLAY_NAME);

  /**
   * 按状态重建菜单。
   * @param status 展示状态
   */
  const applyMenu = (status: TrayStatus): void => {
    const statusLine =
      status.attention > 0
        ? `${status.attention} 个任务等你处理`
        : status.running > 0
          ? `${status.running} 个任务进行中`
          : '暂无进行中的任务';

    const template: MenuItemConstructorOptions[] = [
      { label: APP_DISPLAY_NAME, enabled: false },
      { label: statusLine, enabled: false },
      { type: 'separator' },
      { label: '打开主窗口', accelerator: 'CmdOrCtrl+O', click: actions.onOpen },
      { label: '扫描工具', accelerator: 'CmdOrCtrl+R', click: actions.onScan },
      {
        label: '静音播报',
        type: 'checkbox',
        checked: status.muted,
        click: actions.onToggleMute,
      },
      { type: 'separator' },
      { label: '退出', click: actions.onQuit },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));

    if (process.platform === 'darwin') {
      tray.setTitle(status.attention > 0 ? String(status.attention) : status.muted ? '静' : '');
    }
  };

  applyMenu({ attention: 0, running: 0, muted: false });

  tray.on('click', () => {
    actions.onOpen();
  });

  return {
    tray,
    update: applyMenu,
  };
}
