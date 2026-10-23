# Claude Code、Cursor 与扩展的任务播报接入

AWM 的安装识别、MCP 工具和任务事件接入分别有独立用途。开始/完成播报使用客户端的官方 Hooks，将最小任务元数据交给本机 AWM。

## 配置步骤

1. 将新版应用放到固定位置，再运行；设置中生成的命令使用该应用的真实绝对路径。
2. 打开“设置 → 任务播报接入”，复制对应文件内容。保留已有设置、Hooks 和脚本逻辑，合并桥接调用。
3. 按下表保存配置；重新加载 Cursor 或客户端 Agent，然后发送新任务。
4. 检查接入卡片的“最近收到事件”。这是收到任务事件的时间，不表示持续连接。
5. 开启语音、关闭全局静音，确认当前不在免打扰时段，或调整时段后再验收声音。

| 工具                        | 配置位置                                                          | 开始信号             | 结束信号                            |
| --------------------------- | ----------------------------------------------------------------- | -------------------- | ----------------------------------- |
| Claude Code                 | `~/.claude/settings.json`                                         | `UserPromptSubmit`   | `Stop`                              |
| Cursor 自带 Agent / 聊天    | `~/.cursor/hooks.json`                                            | `beforeSubmitPrompt` | `stop`：completed / aborted / error |

Cursor 还配置 `preToolUse`：Agent 弹出提问框时走内部 `AskQuestion` 工具，桥接只把该工具调用记为 `task.waiting_human`，其他工具调用一律忽略。Cursor 没有专门的“等待确认”事件，这是当前唯一可靠信号；`stop` 会在提问框仍然打开时触发，因此不能把 `stop` 当成完成。
| Cline 4.1.25                | `~/Documents/Cline/Hooks/TaskStart`、`TaskComplete`、`TaskCancel` | `TaskStart`          | `TaskComplete` / `TaskCancel`       |
| CodeBuddy IDE 4.12.39997873 | `~/.codebuddy/settings.json`，或项目 `.codebuddy/settings.json`   | `UserPromptSubmit`   | `Stop`                              |

Claude Code 还配置 `Notification` 事件并以 `matcher: "permission_prompt"` 只接收权限确认提醒，映射为等待用户确认。Claude Code 会把 `UserPromptSubmit` 的纯文本 stdout 注入 Agent 上下文，因此桥接在所有阶段只输出 `{}`。

Cline 的三个文件是可执行脚本，需要 `chmod u+x` 并在 Cline Feature Settings 中启用 Hooks。已有同名脚本时合并调用，不能覆盖原逻辑。CodeBuddy 项目配置可能覆盖用户配置；存在项目 Hooks 时将条目合并到项目对应配置。

当前复制命令面向 macOS/Linux 的 shell；本轮仅验收 macOS arm64。配置仍由用户保存，AWM 不自动改写客户端文件。

## 播报范围、内容与音色

- 范围（`voice.scope`）：`attention`（默认，只播待确认）、`milestones`（待确认 + 开始/完成）、`all`。失败、取消、超时、恢复和重试等事件即使范围为 `all` 也只通知或静音；超出范围的事件同样只发通知，且不占用去抖窗口。
- 内容（`voice.content`）：`title`（默认）播精简后的会话标题——去掉代码块、行内代码、链接与 Markdown 记号，截到第一个句读，最多 24 字；`prompt` 播适配器给出的前 40 字标题原文。各工具都没有独立的会话名，标题只来自用户首条输入，因此不播报完整正文。
- 提醒包含工具名、任务标题和事件。没有可靠标题时使用与看板一致的稳定短编号。
- macOS 列出本机已安装的中文音色（善怡粤语、婷婷普通话、Shelley/Sandy/Reed/Rocko/Eddy/Flo 增强款普通话）与常用英文音色；自动播报只用中文音色兜底（优先普通话增强款，其次婷婷普通话，粤语善怡排最后），英文音色必须手动选择。本地 Kokoro 提供 100 个普通话音色与 3 个英语音色；本地 ZipVoice 用一段参考录音复刻音色，需选择 WAV 并逐字填写录音原文，模型与声码器共约 162MB。试听每次点击播放一次。
- 播报文本在合成前做确定性归一化（时间、百分比、版本号、容量/耗时），看板与通知原文不变。云 TTS（小米 MiMo）默认关闭，需显式开启并填写 API Key 才会把播报文本发往服务商；Key 只存本机。任何后端失败都返回具体原因，不静默改用其他音色。
- 全局静音和免打扰继续生效。默认免打扰时段为 22:30–08:30，开始/完成在该时段只通知。

## 身份与重复控制

Claude Code 的 Hook 会话身份直接由 `transcript_path` 推导：父目录名作为项目、去扩展名的文件名作为会话键，拼成与 JSONL 文件适配器相同的 `claude-code:{project}:{sessionKey}`，因此 Hook 事件与文件采集落在同一条任务记录上。路径缺失或不可解析时才回退到 `claude-code:hooks:{sha256(session_id)}`。事件 ID 只含派生会话键、`prompt_id`（无则用接收时间）和阶段，不含正文、路径或用户身份。

Cursor 使用 conversation_id + generation_id 区分轮次。CodeBuddy 当前安装版本的公开 IDE 代码也为开始和停止传递 generation_id；缺少该字段时使用会话顺序关联。Cline 的公开安装代码提供 taskId 和原生 timestamp，宿主按来源关联轮次。

标准事件 ID、收据和任务状态在主进程同事务保存；重复投递不再触发播报。缺少开始事件时静默补全，收到新轮次时静默关闭上轮遗留状态。历史记录补采不进入语音队列。

桥接只转发工具身份、阶段、发生时间、最多 40 字的用户标题；`transcript_path` 仅用于推导会话身份，不打开该文件，也不读取聊天正文、附件或凭据。HTTP 仅发往 `127.0.0.1`，使用运行时鉴权；关闭来源读取或忽略工具后，不写入新任务。桥接有输入上限和截止时间，失败时放行客户端，不驱动 Agent 继续工作。

## 已验证边界

Claude Code 只使用开始、完成和权限确认提醒三类信号，不读取 `last_assistant_message`、通知正文或 transcript 文件；批准动作本身只通过其后的开始或完成事件间接观察。

Cursor 的 `preToolUse` 只认可 `AskQuestion`（公开安装包里也写作 `ask_question_tool_call`）这一种工具名，其余工具调用直接丢弃，不把“执行工具前”当作等待确认。同一轮里重复弹出的提问框使用同一事件 ID，去重后只播报一次。

Cline、CodeBuddy 本轮只接入开始和结束；待确认仍须可靠的实际事件。

## Codex 的接入方式

Codex 不通过 Hooks 接入，而是读取它自己写入的 rollout 文件：`~/.codex/sessions/**/*.jsonl`（`CODEX_HOME` 可覆盖），按 `payload.turn_id` 把同一聊天拆成 `…:turn:<turn_id>` 任务。事件来自 `task_started` / `task_complete` / `turn_aborted`，标题只取用户消息首行；审批对话框是瞬时事件，不落盘，所以没有 `waiting_human`。

子 Agent 会各自写一份 rollout，若全部采信就会出现“调用工具、分配子 Agent 也播报”。适配器按公开 `SessionSource` 的序列化形状排除：单键 `internal` 字符串、单键 `subagent` 字符串（`review` / `compact` / `memory_consolidation` / 其他）以及 `subagent: { thread_spawn: {…} }`、`subagent: { other: "…" }` 都不建立任务、不产生播报。多键对象或非 serializer 形状保持原样，不猜测。

Cline 4.1.25 的公开安装代码实际调用 TaskComplete，其版本 README 仍写为未来功能，说明文档存在滞后。CodeBuddy IDE 文档尚未列出 generation_id，但本机 4.12.39997873 的公开代码在 UserPromptSubmit 和 Stop 都传递 requestId。因此实现保留无该字段时的兼容路径，不借用 CLI 专属功能来猜测 IDE 行为。

参考：[Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[Cursor Hooks](https://cursor.com/docs/hooks)、[CodeBuddy IDE Hooks](https://www.codebuddy.cn/docs/ide/Features/Hooks)、[Cline 版本 Hooks 文档](https://github.com/cline/cline/blob/v4.1.25/.clinerules/hooks/README.md)。
