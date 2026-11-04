import { compactSpeechReferences, SPEECH_TITLE_MAX } from '@awm/schema';

/** 已核实的用户消息形状；不把工具输出、助手文本或未知记录用作标题。 */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((value) => {
    const part = object(value);
    return (part?.type === 'text' || part?.type === 'input_text') && typeof part.text === 'string'
      ? [part.text]
      : [];
  });
  return parts.length ? parts.join('\n\n') : undefined;
}

/** @description: 请求标记可出现在控制上下文后，但代码围栏里的同名标题只是用户内容。 */
function requestText(text: string): string {
  const lines = text.split(/\r?\n/);
  const controlPrefix = /^#{1,6}\s+AGENTS\.md instructions\b|^<(environment_context|permissions(?: instructions)?|collaboration_mode|user_instructions|skills_instructions|app-context|multi_agent_mode|multi_agent_role|context_window|context_window_guidance|INSTRUCTIONS)\b/i.test(text);
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    const request = !fence && /^#{1,3}\s+My request(?: for Codex)?:[ \t]*(.*)$/i.exec(line);
    if (request && (index === 0 || controlPrefix))
      return [request[1] ?? '', ...lines.slice(index + 1)].join('\n').trim();
  }
  return text;
}

/** @description: 只剥离明确的控制上下文；普通用户 JSON、代码与自然语言原样保留。 */
function cleanUserText(text: string): string | undefined {
  let value = requestText(text.trim());
  if (/^#{1,6}\s+AGENTS\.md instructions\b/i.test(value)) return undefined;
  const control =
    /^<(environment_context|permissions(?: instructions)?|collaboration_mode|user_instructions|skills_instructions|app-context|multi_agent_mode|multi_agent_role|context_window|context_window_guidance|INSTRUCTIONS)\b[^>]*>[\s\S]*?<\/\1>\s*/i;
  for (let match = control.exec(value); match; match = control.exec(value)) {
    value = value.slice(match[0].length).trimStart();
  }
  if (!value.trim()) return undefined;
  return value.trim().replace(/\s+/g, ' ');
}

/** @description: 原始标题仍限 40 字；含路径引用时另生成有长度上限的播报标题。 */
export function extractUserTitles(
  row: Record<string, unknown>,
): { title: string; speechTitle?: string } | undefined {
  let text: string | undefined;
  if (row.type === 'user') {
    const message = object(row.message);
    if (message && (message.role === undefined || message.role === 'user'))
      text = contentText(message.content);
  } else if (row.type === 'event_msg') {
    const payload = object(row.payload);
    if (payload?.type === 'user_message' && typeof payload.message === 'string')
      text = payload.message;
  } else if (row.type === 'response_item') {
    const payload = object(row.payload);
    if (payload?.type === 'message' && payload.role === 'user') text = contentText(payload.content);
  }
  const cleaned = text === undefined ? undefined : cleanUserText(text);
  if (!cleaned) return undefined;
  // 最多取 60 个 Unicode 字符；避免为可能很长的原始消息创建完整字符数组。
  const rawCharacters = Array.from(cleaned.slice(0, SPEECH_TITLE_MAX * 2));
  const title = rawCharacters.slice(0, 40).join('');
  if (!cleaned.includes('@')) return { title };
  const compact = compactSpeechReferences(cleaned);
  const speechTitle = Array.from(compact.slice(0, SPEECH_TITLE_MAX * 2))
    .slice(0, SPEECH_TITLE_MAX).join('');
  return speechTitle === rawCharacters.slice(0, SPEECH_TITLE_MAX).join('')
    ? { title }
    : { title, speechTitle };
}

/** @description: 仅从真实用户记录取文本，完成结果和审批输出永远不参与标题选择。 */
export function extractUserTitle(row: Record<string, unknown>): string | undefined {
  return extractUserTitles(row)?.title;
}
