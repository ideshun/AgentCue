/**
 * 运行时路径与握手信息（SM-4.2 配套）。
 *
 * 主进程启动时把控制 API 的真实端口与 token 写入 `runtime.json`（权限 0600），
 * MCP 桥接进程（独立进程，由 AI 客户端拉起）读取该文件后连接本地 API。
 * 两侧共用本模块，避免路径与文件名各写一份导致握手失败。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 应用展示名，同时作为各平台 userData 目录名 */
export const APP_NAME = 'AI Workflow Monitor';

/** 控制 API 握手信息 */
export interface RuntimeInfo {
  /** 控制 API 实际监听端口 */
  apiPort: number;
  /** 访问 token */
  token: string;
  /** 主进程 pid */
  pid: number;
  /** 启动时间（ISO 8601） */
  startedAt: string;
}

/**
 * 计算默认数据目录（与 Electron `app.getPath('userData')` 对齐）。
 * @returns 数据目录绝对路径
 */
export function defaultDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', APP_NAME);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), APP_NAME);
}

/**
 * 握手文件路径。
 * @param dataDir 数据目录，缺省用平台默认目录
 * @returns runtime.json 绝对路径
 */
export function runtimeFilePath(dataDir: string = defaultDataDir()): string {
  return path.join(dataDir, 'runtime.json');
}

/**
 * 原子写入握手信息，并收紧权限到仅当前用户可读。
 * @param dataDir 数据目录
 * @param info 握手信息
 */
export function writeRuntimeInfo(dataDir: string, info: RuntimeInfo): void {
  const file = runtimeFilePath(dataDir);
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    // 已存在文件时 mode 参数不生效，显式再收紧一次；Windows 上仅影响只读位，失败不致命
    chmodSync(file, 0o600);
  } catch {
    // 忽略权限收紧失败，文件仍在用户目录下
  }
}

/**
 * 读取握手信息。
 * @param dataDir 数据目录，缺省用平台默认目录
 * @returns 握手信息；文件缺失或字段不合法返回 null
 */
export function readRuntimeInfo(dataDir: string = defaultDataDir()): RuntimeInfo | null {
  const file = runtimeFilePath(dataDir);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RuntimeInfo>;
    if (typeof parsed.apiPort !== 'number' || typeof parsed.token !== 'string') {
      return null;
    }
    return {
      apiPort: parsed.apiPort,
      token: parsed.token,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}
