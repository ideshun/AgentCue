/**
 * voice_rules 表 DAO（FR-11/12/15，MCP set_voice_rule 的落库）。
 */
import { eq } from 'drizzle-orm';
import type { VoiceAction, VoicePriority } from '@awm/schema';
import type { AppDb } from '../db';
import { voiceRules } from '../schema';

/** voice_rules 行类型 */
export type VoiceRuleRow = typeof voiceRules.$inferSelect;

/** 写入规则的入参 */
export interface UpsertVoiceRuleInput {
  /** 规则 id，缺省时按作用域生成，保证幂等 */
  ruleId?: string;
  /** 作用工具，null 表示全部 */
  scopeTool?: string | null;
  /** 作用事件类型 */
  scopeEvent: string;
  action: VoiceAction;
  template?: string | null;
  priority?: VoicePriority | null;
}

/**
 * 生成规则 id：作用域 + 事件，保证同一作用域重复写入是更新而非新增。
 * @param scopeTool 作用工具
 * @param scopeEvent 作用事件
 * @returns 规则 id
 */
export function ruleIdFor(scopeTool: string | null | undefined, scopeEvent: string): string {
  return `${scopeTool ?? '*'}|${scopeEvent}`;
}

/**
 * 幂等写入播报规则。
 * @param db 数据库句柄
 * @param input 规则入参
 * @returns 写入后的行
 */
export function upsertVoiceRule(db: AppDb, input: UpsertVoiceRuleInput): VoiceRuleRow {
  const ruleId = input.ruleId ?? ruleIdFor(input.scopeTool, input.scopeEvent);
  const updatedAt = new Date().toISOString();
  db.insert(voiceRules)
    .values({
      ruleId,
      scopeTool: input.scopeTool ?? null,
      scopeEvent: input.scopeEvent,
      action: input.action,
      template: input.template ?? null,
      priority: input.priority ?? null,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: voiceRules.ruleId,
      set: {
        scopeTool: input.scopeTool ?? null,
        action: input.action,
        template: input.template ?? null,
        priority: input.priority ?? null,
        updatedAt,
      },
    })
    .run();

  const row = db.select().from(voiceRules).where(eq(voiceRules.ruleId, ruleId)).get();
  if (!row) {
    throw new Error(`播报规则写入失败：${ruleId}`);
  }
  return row;
}

/**
 * 查询全部播报规则。
 * @param db 数据库句柄
 * @returns 规则列表
 */
export function listVoiceRules(db: AppDb): VoiceRuleRow[] {
  return db.select().from(voiceRules).all();
}
