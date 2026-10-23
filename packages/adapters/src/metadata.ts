import type { AdapterManifest, BoardItem } from '@awm/schema';

export function sessionCapability(
  manifest: AdapterManifest,
): 'events' | 'metadata' | 'detect-only' {
  return (
    manifest.sessionCapability ??
    (Object.keys(manifest.eventMapping).length ? 'events' : 'detect-only')
  );
}

/** @description: 仅读取已验证索引的白名单字段，不跟随其中的文件路径。 */
export function parseMetadataIndex(value: unknown, format: string, toolId: string): BoardItem[] {
  let entries: unknown[];
  if (format === 'cline-history-v1' && Array.isArray(value)) entries = value;
  else if (
    format === 'cline-sessions-v1' &&
    value &&
    typeof value === 'object' &&
    (value as { version?: unknown }).version === 1
  ) {
    const sessions = (value as { sessions?: unknown }).sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions))
      throw new Error('不支持的会话索引格式');
    entries = Object.values(sessions);
  } else throw new Error('不支持的历史索引格式');
  const result: BoardItem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const id = format === 'cline-history-v1' ? item.id : item.sessionId;
    const rawTitle = format === 'cline-history-v1' ? item.task : item.prompt;
    const timestamp = format === 'cline-history-v1' ? item.ts : (item.updatedAt ?? item.startedAt);
    if (typeof id !== 'string' || id.length === 0 || id.length > 500) continue;
    if (typeof timestamp !== 'number' && typeof timestamp !== 'string') continue;
    const time = new Date(timestamp);
    if (!Number.isFinite(time.getTime())) continue;
    const title =
      typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
    result.push({
      kind: 'history',
      sessionId: `${toolId}:history:${id}`,
      toolId,
      title: title || '未命名历史任务',
      currentState: null,
      updatedAt: time.toISOString(),
      ...(typeof item.status === 'string' ? { sourceStatus: item.status.slice(0, 60) } : {}),
    });
  }
  return result;
}
