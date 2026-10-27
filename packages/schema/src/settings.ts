/**
 * settings.json 结构（详细设计 5.8）。
 * 用户设置落盘于数据目录，原子写；schemaVersion 独立演进。
 */
import { z } from 'zod';

/** 免打扰时段 */
export const quietRangeSchema = z.object({
  from: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时段格式应为有效的 HH:mm'),
  to: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时段格式应为有效的 HH:mm'),
});

/** 用户手动添加的自定义工具路径 */
export const customToolSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'id 仅允许小写字母、数字与连字符'),
  name: z.string().min(1),
  configPath: z.string().min(1),
});

/** 自定义工具类型 */
export type CustomTool = z.infer<typeof customToolSchema>;

/** 扫描设置 */
export const scanSettingsSchema = z.object({
  autoIntervalHours: z.number().int().positive().default(6),
  ignoredToolIds: z.array(z.string()).default([]),
  customTools: z.array(customToolSchema).default([]),
});

/**
 * 小米 MiMo 开放平台的默认 TTS 接口地址。
 * 设置里直接填入这个值而不是留空，界面才能显示、修改并一键恢复默认。
 */
export const DEFAULT_CLOUD_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';

/** 语音设置 */
export const voiceSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** 内置播报规则迁移版本，仅供宿主启动时升级。 */
  rulesRevision: z.number().int().nonnegative().default(0),
  volume: z.number().min(0).max(1).default(0.8),
  rate: z.number().min(0.5).max(2).default(1),
  voiceProfile: z.string().default('system-default'),
  /** 用户试听后命名并收藏的音色，旧设置自动填充空列表。 */
  savedVoices: z
    .array(z.object({ profile: z.string().min(1).max(80), name: z.string().trim().min(1).max(32) }))
    .max(100)
    .refine(
      (voices) => new Set(voices.map((voice) => voice.profile)).size === voices.length,
      '常用音色不能重复',
    )
    .default([]),
  backend: z.enum(['native', 'piper', 'cloud', 'local']).default('native'),
  /**
   * 本地引擎：Kokoro 预置发音人（默认），或 ZipVoice 零样本音色。
   * 切换引擎会换一套模型目录与音色语义，不影响云/系统后端。
   */
  localEngine: z.enum(['kokoro', 'zipvoice']).default('kokoro'),
  /** ZipVoice 参考音频路径（用户选择后复制到本机数据目录）；空则不可用。 */
  zipvoiceReferencePath: z.string().max(500).default(''),
  /** 与参考音频逐字对应的文本，ZipVoice 每次合成都需要。 */
  zipvoiceReferenceText: z.string().max(500).default(''),
  /**
   * 播报范围：只播需要你处理的事，还是把进展也读出来。
   * - 'attention'：仅待确认（默认）
   * - 'milestones'：待确认 + 开始/完成
   * - 'all'：全部事件
   */
  scope: z.enum(['attention', 'milestones', 'all']).default('attention'),
  /**
   * 播报内容来源：会话标题（短、可听）还是用户输入正文（可能很长）。
   * - 'title'：只播标题（默认）
   * - 'prompt'：播报用户输入原文
   */
  content: z.enum(['title', 'prompt']).default('title'),
  /** 云 TTS 必须显式开启，默认关闭且不出网 */
  cloudEnabled: z.boolean().default(false),
  /** 云 TTS 服务商；目前只支持小米 MiMo（OpenAI 兼容接口）。 */
  cloudProvider: z.enum(['mimo']).default('mimo'),
  /** 云 TTS POST 地址；默认填入 MiMo 官方地址，可改为兼容服务，留空仍按官方地址处理。 */
  cloudEndpoint: z.string().max(500).default(DEFAULT_CLOUD_ENDPOINT),
  /** 云 TTS 模型名；空则使用 MiMo 默认 TTS 模型。 */
  cloudModel: z.string().max(120).default(''),
  /** 云 TTS 预置音色名；空则使用 MiMo 默认音色 mimo_default。 */
  cloudVoice: z.string().max(80).default(''),
  /** API Key 只保存在本机 settings.json，不进仓库、不写审计。 */
  cloudApiKey: z.string().max(500).default(''),
});

/** 免打扰设置 */
export const quietSettingsSchema = z.object({
  globalMute: z.boolean().default(false),
  ranges: z.array(quietRangeSchema).default([{ from: '22:30', to: '08:30' }]),
  /** waiting_human 是否突破免打扰 */
  waitingHumanOverride: z.boolean().default(true),
});

/** 隐私设置 */
export const privacySettingsSchema = z.object({
  sessionFileRead: z.boolean().default(true),
  auditLog: z.boolean().default(true),
  scanScope: z.enum(['minimal', 'standard', 'full']).default('minimal'),
});

/** 完整设置对象 */
export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  scan: scanSettingsSchema.default({ autoIntervalHours: 6, ignoredToolIds: [], customTools: [] }),
  voice: voiceSettingsSchema.default({
    enabled: true,
    rulesRevision: 0,
    volume: 0.8,
    rate: 1,
    voiceProfile: 'system-default',
    savedVoices: [],
    backend: 'native',
    localEngine: 'kokoro',
    zipvoiceReferencePath: '',
    zipvoiceReferenceText: '',
    cloudEnabled: false,
    cloudProvider: 'mimo',
    cloudEndpoint: DEFAULT_CLOUD_ENDPOINT,
    cloudModel: '',
    cloudVoice: '',
    cloudApiKey: '',
  }),
  quiet: quietSettingsSchema.default({
    globalMute: false,
    ranges: [{ from: '22:30', to: '08:30' }],
    waitingHumanOverride: true,
  }),
  privacy: privacySettingsSchema.default({
    sessionFileRead: true,
    auditLog: true,
    scanScope: 'minimal',
  }),
});

/** 设置类型 */
export type Settings = z.infer<typeof settingsSchema>;

/** 构造默认设置（含默认值填充） */
export function defaultSettings(): Settings {
  return settingsSchema.parse({ schemaVersion: 1 });
}
