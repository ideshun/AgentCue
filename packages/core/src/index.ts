/**
 * @awm/core 统一出口。
 * 约束：本包不得出现任何具体工具名字符串（由 tests/contract 断言）。
 */
export * from './statemachine/transition-table';
export * from './statemachine/task-machine';
export * from './bus/event-bus';
export * from './normalize/normalize';
export * from './scanner/detector';
export * from './scanner/orchestrator';
export * from './heartbeat/monitor';
export * from './voice/rule-engine';
export * from './voice/speech-text';
export * from './voice/tts';
export * from './voice/pipeline';
export * from './voice/debouncer';
export * from './voice/quiet-hours';
export * from './voice/queue';
export * from './mcp/tools';
export * from './runtime/paths';
