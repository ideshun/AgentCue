import { describe, expect, it } from 'vitest';
import { compactSpeechReferences } from './speech';

describe('compactSpeechReferences', () => {
  it.each([
    ['@/Users/example/Data/Code/wukuang/ 审查这个项目', 'wukuang 审查这个项目'],
    [
      '改造 @minmetals-ui/packages/biz-components 的 org-user-group-picker 组件',
      '改造 biz-components 的 org-user-group-picker 组件',
    ],
    ['查看 @"/tmp/带 空格/文件.ts" 和 @C:\\work\\a\\b.ts', '查看 文件.ts 和 b.ts'],
    ['**@/a/b/**，继续', '**b**，继续'],
  ])('播报只保留引用路径的末段：%s', (input, expected) => {
    expect(compactSpeechReferences(input)).toBe(expected);
    expect(compactSpeechReferences(expected)).toBe(expected);
  });

  it('保留普通 URL、邮箱、非引用的斜杠文本和没有路径的 @ 提及', () => {
    const text = '联系 name@example.com，打开 https://example.com/a，检查 api/v1 和 @someone';
    expect(compactSpeechReferences(text)).toBe(text);
  });
});
