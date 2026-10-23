/**
 * mcp_servers 表 DAO（FR-18 外部 MCP 汇聚）。
 */
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db';
import { mcpServers } from '../schema';

/** MCP server 行 */
export type McpServerRow = typeof mcpServers.$inferSelect;

/** 写入入参 */
export interface UpsertMcpServerInput {
  serverId?: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  status?: string;
  tools?: unknown[] | null;
  validationStatus?: 'unverified' | 'verified' | 'error';
  lastValidatedAt?: string | null;
  lastError?: string | null;
}

/**
 * 幂等写入外部 MCP Server 配置。
 * @param db 数据库句柄
 * @param input 配置
 * @returns 写入后的行
 */
export function upsertMcpServer(db: AppDb, input: UpsertMcpServerInput): McpServerRow {
  const serverId =
    input.serverId ?? `mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const values = {
    serverId,
    name: input.name,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    url: input.url ?? null,
    status: input.status ?? 'disconnected',
    tools: input.tools ? JSON.stringify(input.tools) : null,
    validationStatus: input.validationStatus ?? 'unverified',
    lastValidatedAt: input.lastValidatedAt ?? null,
    lastError: input.lastError ?? null,
  };
  db.insert(mcpServers)
    .values(values)
    .onConflictDoUpdate({
      target: mcpServers.serverId,
      set: {
        name: values.name,
        transport: values.transport,
        command: values.command,
        args: values.args,
        url: values.url,
        status: values.status,
        tools: values.tools,
        validationStatus: values.validationStatus,
        lastValidatedAt: values.lastValidatedAt,
        lastError: values.lastError,
      },
    })
    .run();
  const row = db.select().from(mcpServers).where(eq(mcpServers.serverId, serverId)).get();
  if (!row) {
    throw new Error(`写入 MCP Server 后读回失败：${serverId}`);
  }
  return row;
}

/**
 * 列出外部 MCP Server。
 * @param db 数据库句柄
 * @returns 行列表
 */
export function listMcpServers(db: AppDb): McpServerRow[] {
  return db.select().from(mcpServers).all();
}

/**
 * 删除外部 MCP Server。
 * @param db 数据库句柄
 * @param serverId 主键
 */
export function deleteMcpServer(db: AppDb, serverId: string): void {
  db.delete(mcpServers).where(eq(mcpServers.serverId, serverId)).run();
}
