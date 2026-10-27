/**
 * 三层探测器（SM-1.2）：配置存在性 → 进程/版本 → 运行时 API。
 * 结果合并为四态：installed / running / not_installed / unknown（FLOW-01 第 4 步）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ApiProbe, DetectStatus } from '@awm/schema';

const execFileAsync = promisify(execFile);

/** 探测结果 */
export interface DetectResult {
  /** 适配器 id */
  toolId: string;
  /** 四态判定 */
  status: DetectStatus;
  /** 版本号（进程探测带 --version 时） */
  version?: string | null;
  /** 命中的配置路径 */
  configPath?: string | null;
  /** 命中的可执行文件路径 */
  executablePath?: string | null;
  /** 探测降级原因，正常为 null */
  degradedReason?: string | null;
}

/**
 * 展开路径中的 `~` 与 Windows 环境变量。
 * @param raw 原始路径
 * @returns 展开后的绝对路径
 */
export function expandPath(raw: string): string {
  let value = raw;
  if (value.startsWith('~')) {
    value = path.join(homedir(), value.slice(1));
  }
  // Windows 风格环境变量，如 %USERPROFILE%
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => {
    return process.env[name] ?? '';
  });
  return value;
}

/**
 * 第一层：配置文件是否存在。
 * @param candidates 候选路径列表
 * @returns 命中的路径，未命中返回 null
 */
export function detectConfigPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const resolved = expandPath(candidate);
    if (resolved !== '' && existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

/** 进程探测结果 */
export interface ProcessProbeResult {
  /** 是否存在匹配进程 */
  running: boolean;
  /** 命中的可执行文件路径 */
  executablePath?: string | null;
}

/**
 * 第二层：进程探测。
 * macOS/Linux 走 `ps -ax -o pid=,command=`，Windows 走 `tasklist`。
 * 只匹配命令名本身（ps 行 command 首 token 的 basename / tasklist 映像名），
 * 参数或其他路径里的子串不再误报 running。
 * @param processNames 进程名列表
 * @returns 进程探测结果
 */
export async function detectProcess(processNames: string[]): Promise<ProcessProbeResult> {
  if (processNames.length === 0) {
    return { running: false };
  }
  try {
    const windows = platform() === 'win32';
    const output = windows ? await readTasklist() : await readPs();
    for (const name of processNames) {
      const line = matchProcessLine(output, name, windows);
      if (line !== null) {
        return { running: true, executablePath: extractExecutable(line) };
      }
    }
    return { running: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`进程探测失败：${message}`);
  }
}

/**
 * 按命令名精确匹配进程列表中的某一行。
 * @param output 进程列表输出
 * @param name 进程名
 * @param windows 是否为 tasklist CSV 输出
 * @returns 命中的原始行，未命中返回 null
 */
export function matchProcessLine(output: string, name: string, windows: boolean): string | null {
  const target = name.toLowerCase();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (windows) {
      const image = (line.split(',')[0] ?? '').replace(/^"|"$/g, '').toLowerCase();
      if (image === target || image === `${target}.exe`) return raw;
      continue;
    }
    // `ps -ax -o pid=,command=`：首 token 是数字 PID，其后是可执行命令与参数。
    const tokens = line.split(/\s+/);
    const command = /^\d+$/.test(tokens[0] ?? '') ? tokens[1] : tokens[0];
    if (!command) continue;
    const base = command.substring(command.lastIndexOf('/') + 1).toLowerCase();
    if (base === target || base === `${target}.exe`) return raw;
  }
  return null;
}

/**
 * 读取 macOS/Linux 进程列表。
 * @returns ps 输出
 */
async function readPs(): Promise<string> {
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * 读取 Windows 进程列表。
 * @returns tasklist 输出
 */
async function readTasklist(): Promise<string> {
  const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * 从命中的进程行中提取可执行文件路径。
 * @param line 命中的进程行
 * @returns 可执行文件路径，取不到返回 null
 */
function extractExecutable(line: string): string | null {
  const match = /\S*\/[^\s]*|\S*\\[^\s]*/.exec(line.trim());
  return match ? match[0] : null;
}

/**
 * 第三层：运行时 API 探测。
 * @param apis 探测点列表
 * @returns 是否有任一探测点可用
 */
export async function detectApis(apis: ApiProbe[]): Promise<boolean> {
  for (const api of apis) {
    const url = `http://${api.host}:${api.port}${api.probePath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        return true;
      }
    } catch {
      // 单个探测点失败继续尝试下一个
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/**
 * 合并三层结果为四态。
 * 规则：进程命中或 API 可用 = running；配置存在但进程缺失 = installed；
 * 配置与进程都缺失 = not_installed。
 * @param configHit 配置是否命中
 * @param processRunning 进程是否运行
 * @param apiReachable API 是否可达
 * @returns 四态之一
 */
export function mergeDetectStatus(
  configHit: boolean,
  processRunning: boolean,
  apiReachable: boolean,
): DetectStatus {
  if (processRunning || apiReachable) {
    return 'running';
  }
  if (configHit) {
    return 'installed';
  }
  return 'not_installed';
}
