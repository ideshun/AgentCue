/**
 * 适配器 manifest Schema（详细设计 5.4）。
 * 适配器是唯一允许出现具体工具名的模块，core 不得出现任何工具名字符串。
 */
import { z } from 'zod';

/** 单个配置路径条目：按平台给路径，支持环境变量覆盖 */
export const configPathSchema = z.object({
  mac: z.string().optional(),
  win: z.string().optional(),
  linux: z.string().optional(),
  envOverride: z.array(z.string()).optional(),
});

/** 运行时 API 探测点 */
export const apiProbeSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  probePath: z.string(),
});

/** 运行时 API 探测点类型 */
export type ApiProbe = z.infer<typeof apiProbeSchema>;

/** 三层探测配置（配置存在性 → 进程 → 运行时 API） */
export const detectConfigSchema = z.object({
  configPaths: z.array(configPathSchema).default([]),
  processNames: z.array(z.string()).default([]),
  apis: z.array(apiProbeSchema).default([]),
  extensions: z
    .array(
      z.object({
        id: z.string().min(1),
        host: z.string().min(1),
        roots: z.array(configPathSchema),
      }),
    )
    .optional(),
});

/** 会话来源类型 */
export const sessionSourceTypeSchema = z.enum([
  'jsonl',
  'dir-watch',
  'api',
  'process-event',
  'json-index',
  'none',
]);

/** 会话来源 */
export const sessionSourceSchema = z.object({
  type: sessionSourceTypeSchema,
  pathPattern: z.string().optional(),
  url: z.string().optional(),
  indexes: z
    .array(
      z.object({
        format: z.string().min(1),
        paths: z.array(configPathSchema),
      }),
    )
    .optional(),
});

/** 单条事件映射规则 */
export const eventMappingEntrySchema = z.object({
  /** 原始信号中用于匹配的值或字段路径 */
  match: z.string(),
  reason: z.string().optional(),
  /** 仅在区分成功/失败时使用 */
  ok: z.boolean().optional(),
});

/** 心跳探测方式 */
export const heartbeatProbeSchema = z.enum(['file_mtime', 'api_ping', 'process_alive']);

/** 心跳探测方式类型 */
export type HeartbeatProbe = z.infer<typeof heartbeatProbeSchema>;

/** 心跳配置 */
export const heartbeatSchema = z.object({
  intervalSec: z.number().int().positive(),
  probe: heartbeatProbeSchema,
});

/** MCP 接入配置相关声明 */
export const mcpSectionSchema = z.object({
  clientConfigFormat: z.string().optional(),
});

/** 适配器 manifest */
export const adapterManifestSchema = z.object({
  /** 适配器唯一 id，仅小写字母、数字与连字符 */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'id 仅允许小写字母、数字与连字符'),
  name: z.string().min(1),
  sessionCapability: z.enum(['events', 'metadata', 'detect-only']).optional(),
  capabilityReason: z.string().optional(),
  detect: detectConfigSchema,
  sessionSource: sessionSourceSchema,
  /** 键为目标语义（如 waiting_human / completed / failed），值为匹配规则 */
  eventMapping: z.record(z.string(), eventMappingEntrySchema),
  heartbeat: heartbeatSchema,
  mcp: mcpSectionSchema.optional(),
  /** 复杂解析走 TS 提取器，相对 manifest 的路径 */
  extractor: z.string().optional(),
});

/** 适配器 manifest 类型 */
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;

/** 三层探测配置类型 */
export type DetectConfig = z.infer<typeof detectConfigSchema>;
