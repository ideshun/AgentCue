/**
 * settings.json 持久化（详细设计 5.8）。
 *
 * 约束：
 * - 原子写（临时文件 + rename），避免断电/崩溃留下半截 JSON
 * - 解析失败不抛错：备份损坏文件后回落默认值，保证应用永远能启动
 * - schemaVersion 独立演进，升级逻辑集中在 migrate()
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveCloudEndpoint } from '@awm/core';
import { defaultSettings, settingsSchema, type Settings } from '@awm/schema';

/** 设置文件内可增量更新的分区名 */
const SECTION_KEYS = ['scan', 'voice', 'quiet', 'privacy'] as const;

/** 分区名类型 */
type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * 合并单个分区，非对象入参视为未修改。
 * @param base 原分区
 * @param patch 待合并内容
 * @returns 合并后的分区
 */
function mergeSection<T extends object>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return base;
  }
  return { ...base, ...(patch as Partial<T>) };
}

/**
 * 判断是否为合法分区名。
 * @param key 待判断的键
 * @returns 是否为分区名
 */
function isSectionKey(key: string): key is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(key);
}

/**
 * 规范化云 TTS 接口地址。
 * - 旧版本用空串表示官方地址，设置页因此只能显示占位符；补成真实地址后可显示、可恢复默认。
 * - 粘贴文档里的基础地址（`…/v1`、`…/anthropic`）时补成真正 POST 的 `…/v1/chat/completions`，
 *   否则试听只会拿到网关 404。
 * @param settings 已通过 schema 校验的设置
 * @returns 接口地址已规范化的设置
 */
function withResolvedEndpoint(settings: Settings): Settings {
  const endpoint = resolveCloudEndpoint(settings.voice.cloudEndpoint);
  if (endpoint === settings.voice.cloudEndpoint) return settings;
  return { ...settings, voice: { ...settings.voice, cloudEndpoint: endpoint } };
}

/** 设置仓库：内存持有当前设置，写操作显式落盘 */
export class SettingsStore {
  /** 设置文件绝对路径 */
  private readonly filePath: string;

  /** 当前设置 */
  private current: Settings;

  /**
   * @param filePath settings.json 绝对路径
   */
  constructor(filePath: string) {
    this.filePath = filePath;
    this.current = this.read();
  }

  /**
   * 读取磁盘设置，异常时回落默认值。
   * @returns 设置对象
   */
  private read(): Settings {
    if (!existsSync(this.filePath)) {
      return defaultSettings();
    }
    try {
      // 旧版本按系统 umask 创建文件，启动时收紧权限但不改写内容。
      chmodSync(this.filePath, 0o600);
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const result = settingsSchema.safeParse(parsed);
      if (result.success) {
        return withResolvedEndpoint(result.data);
      }
      this.backupCorrupted();
      return defaultSettings();
    } catch {
      this.backupCorrupted();
      return defaultSettings();
    }
  }

  /**
   * 备份损坏的设置文件，文件名带时间戳，便于事后排障。
   */
  private backupCorrupted(): void {
    try {
      writeFileSync(`${this.filePath}.corrupt-${Date.now()}`, readFileSync(this.filePath), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch {
      // 备份失败不阻断启动流程
    }
  }

  /**
   * 读取当前设置。
   * @returns 设置对象（只读使用，修改需走 update）
   */
  get(): Settings {
    return this.current;
  }

  /**
   * 增量更新设置并落盘。
   * 只允许修改分区对象，未知键直接忽略，避免外部注入 schemaVersion 等敏感字段。
   * @param patch 分区级补丁，如 `{ voice: { enabled: false } }`
   * @returns 更新后的完整设置
   * @throws 合并结果未通过 schema 校验时抛出，且不落盘
   */
  update(patch: Record<string, unknown>): Settings {
    const next: Record<string, unknown> = { ...this.current };
    for (const [key, value] of Object.entries(patch)) {
      if (!isSectionKey(key)) {
        continue;
      }
      next[key] = mergeSection(this.current[key], value);
    }
    const parsed = withResolvedEndpoint(settingsSchema.parse(next));
    this.save(parsed);
    this.current = parsed;
    return parsed;
  }

  /**
   * 原子写盘：先写临时文件再 rename 覆盖。
   */
  save(value: Settings = this.current): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      // mode 只影响新建文件；崩溃残留的临时文件也必须先收紧权限再写入密钥。
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.filePath);
  }
}
