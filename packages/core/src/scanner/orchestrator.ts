/**
 * 扫描编排器（SM-1.3）：触发源管理、并发控制、结果合并、忽略清单。
 * 单个适配器探测异常只标记 degraded，不中断整体扫描（FLOW-01 第 6 步）。
 */
import type { AdapterManifest } from '@awm/schema';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import {
  detectApis,
  detectConfigPath,
  detectProcess,
  mergeDetectStatus,
  type DetectResult,
  expandPath,
} from './detector';

/** 扫描选项 */
export interface ScanOptions {
  /** 并发上限，默认 4 */
  concurrency?: number;
  /** 忽略的适配器 id */
  ignoredToolIds?: string[];
}

/** 单次扫描汇总 */
export interface ScanReport {
  /** 探测成功的结果 */
  results: DetectResult[];
  /** 探测降级（异常）的适配器 */
  degraded: Array<{ toolId: string; reason: string }>;
  /** 扫描开始与结束时间 */
  startedAt: string;
  finishedAt: string;
}

/**
 * 取当前平台对应的配置路径。
 * @param manifest 适配器 manifest
 * @returns 当前平台的候选路径
 */
function platformPaths(manifest: AdapterManifest): string[] {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const paths: string[] = [];
  for (const entry of manifest.detect.configPaths) {
    const candidate = isWin ? entry.win : isMac ? entry.mac : entry.linux;
    if (candidate) {
      paths.push(candidate);
    }
    // 环境变量覆盖优先级更高
    for (const envName of entry.envOverride ?? []) {
      const fromEnv = process.env[envName];
      if (fromEnv) {
        paths.push(fromEnv);
      }
    }
  }
  return paths;
}

/** @description: 只读取显式声明的扩展根下匹配身份的公开清单。 */
export function detectExtensions(
  manifest: AdapterManifest,
): { configPath: string; version?: string; host: string } | null {
  for (const extension of manifest.detect.extensions ?? []) {
    for (const entry of extension.roots) {
      const raw =
        process.platform === 'win32'
          ? entry.win
          : process.platform === 'darwin'
            ? entry.mac
            : entry.linux;
      if (!raw) continue;
      const root = expandPath(raw);
      try {
        const candidates = readdirSync(root, { withFileTypes: true })
          .filter(
            (item) =>
              item.isDirectory() &&
              item.name.toLowerCase().startsWith(`${extension.id.toLowerCase()}-`),
          )
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        for (const item of candidates) {
          try {
            const file = path.join(root, item.name, 'package.json');
            const stat = lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
            const info = JSON.parse(readFileSync(file, 'utf8')) as {
              publisher?: string;
              name?: string;
              version?: string;
            };
            if (
              `${info.publisher ?? ''}.${info.name ?? ''}`.toLowerCase() ===
              extension.id.toLowerCase()
            ) {
              return {
                configPath: file,
                version: typeof info.version === 'string' ? info.version : undefined,
                host: extension.host,
              };
            }
          } catch {
            /* 单个半安装的版本不遮蔽其他有效版本。 */
          }
        }
      } catch {
        /* 安装/卸载途中或不可读的目录交由下一个声明来源。 */
      }
    }
  }
  return null;
}

/**
 * 探测单个适配器。
 * @param manifest 适配器 manifest
 * @returns 探测结果，异常时降级为 unknown 并带原因
 */
async function probeOne(manifest: AdapterManifest): Promise<DetectResult> {
  const extension = detectExtensions(manifest);
  const configPath = extension?.configPath ?? detectConfigPath(platformPaths(manifest));
  let processRunning = false;
  let executablePath: string | null = null;
  try {
    const processResult = await detectProcess(manifest.detect.processNames);
    processRunning = processResult.running;
    executablePath = processResult.executablePath ?? null;
  } catch {
    // 进程探测失败不致命，降级为按配置判定
    processRunning = false;
  }

  let apiReachable = false;
  if (manifest.detect.apis.length > 0) {
    apiReachable = await detectApis(manifest.detect.apis);
  }

  return {
    toolId: manifest.id,
    status: mergeDetectStatus(configPath !== null, processRunning, apiReachable),
    configPath,
    executablePath,
    degradedReason: null,
    version: extension?.version,
  };
}

/**
 * 按并发上限分批执行任务。
 * @param items 待处理项
 * @param limit 并发上限
 * @param worker 处理函数
 * @returns 结果数组（含 rejected 转为失败标记）
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: string }> = [];
  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    const settled = await Promise.allSettled(batch.map(worker));
    settled.forEach((item) => {
      if (item.status === 'fulfilled') {
        results.push({ ok: true, value: item.value });
      } else {
        const reason = item.reason instanceof Error ? item.reason.message : String(item.reason);
        results.push({ ok: false, error: reason });
      }
    });
  }
  return results;
}

/**
 * 扫描编排器：对注册适配器执行三层探测并汇总。
 */
export class ScanOrchestrator {
  /** 已注册适配器 */
  private readonly manifests: AdapterManifest[];

  /**
   * @param manifests 适配器 manifest 列表
   */
  constructor(manifests: AdapterManifest[]) {
    this.manifests = manifests;
  }

  /**
   * 执行一次扫描。
   * @param options 扫描选项
   * @returns 扫描汇总
   */
  async scan(options: ScanOptions = {}): Promise<ScanReport> {
    const ignored = new Set(options.ignoredToolIds ?? []);
    const targets = this.manifests.filter((manifest) => !ignored.has(manifest.id));
    const startedAt = new Date().toISOString();

    const settled = await mapWithConcurrency(targets, options.concurrency ?? 4, probeOne);

    const results: DetectResult[] = [];
    const degraded: Array<{ toolId: string; reason: string }> = [];
    settled.forEach((item, index) => {
      const manifest = targets[index];
      if (!manifest) {
        return;
      }
      if (item.ok) {
        results.push(item.value);
      } else {
        degraded.push({ toolId: manifest.id, reason: item.error });
        results.push({
          toolId: manifest.id,
          status: 'unknown',
          degradedReason: item.error,
        });
      }
    });

    return { results, degraded, startedAt, finishedAt: new Date().toISOString() };
  }
}
