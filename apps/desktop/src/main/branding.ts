import path from 'node:path';

/** Shared local artwork for windows, the macOS Dock and system notifications. */
export const APP_ICON_PATH = path.join(__dirname, '../renderer/assets/brand/app-icon.png');

/** The paired tray@2x.png supplies the high-density menu-bar representation. */
export const TRAY_ICON_PATH = path.join(__dirname, '../renderer/assets/brand/tray.png');
