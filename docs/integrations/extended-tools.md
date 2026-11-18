# 更多工具与自定义图标

工具安装识别和任务事件接入是独立状态。接入模板在“播报接入”页面；配置需合并，不能整份覆盖原工具配置。AgentCue 不自动批准工具权限，也不修改原工具的任务。

| 工具 | 接口 | 支持的事件及限制 |
| --- | --- | --- |
| DeepSeek Harness | 本地 Cordis 插件，监听提交后的 `session/event` | `turn/start` 开始；`turn/end` 明确区分 completed、aborted、error、max-tokens、blocked。不将预停止的 Stop 当成功。不读取会话正文，暂不推断等待确认。CLI 和桌面启用的 profile 需分别配置。 |
| OpenCode 2 | `@opencode/plugin` 的事件订阅 | execution.started / succeeded / failed / interrupted；permission.asked / replied。忽略 session.idle，不兼容 OpenCode 1 插件接口。插件退出时终止订阅。 |
| Gemini CLI | 用户级 settings.json 命令 Hooks | BeforeAgent、AfterAgent、ToolPermission 通知。仅表示一轮响应结束，不能证明用户目标已完成；不从通知文本推断失败。 |
| Qwen Code | 用户级 settings.json 命令 Hooks | 带 submitted_prompt 的 UserPromptSubmit、Stop、StopFailure、permission_prompt 通知。忽略工具续跑；旧版本没有 submitted_prompt 时可能缺少开始事件。 |

模板中的可执行文件路径由当前安装位置生成。Windows 命令配置使用双引号路径；原生插件直接启动子进程，不拼接 shell。插件只转发生命周期、会话标识和时间；插件转发失败不阻断原工具。

这些实现按官方公开协议编写，合成协议与插件转发测试不代替各版本工具的实机验收。配置后应执行一个新任务，检查“播报接入”中的事件时间。

## MCP 接入

四个工具均在“播报接入”的对应工具下提供 MCP 配置，使用当前 AgentCue 安装路径的 stdio 桥接：

- Gemini CLI：`~/.gemini/settings.json`（或项目 `.gemini/settings.json`）的 `mcpServers`。
- Qwen Code：`~/.qwen/settings.json`（或项目 `.qwen/settings.json`）的 `mcpServers`。
- OpenCode 2：`opencode.jsonc` 的 `mcp.servers`，命令是数组；不使用 OpenCode 1 的平铺配置。
- DeepSeek Harness：当前 Cordis profile 的插件列表，添加 `@deepseek-ai/dsh-mcp-client` 的 YAML 条目；CLI 与桌面 profile 分别配置。

配置要合并到原文件。桥接验证只验证 AgentCue 服务；还需在客户端确认连接、枚举工具并实际调用。MCP 连接本身不会自动产生任务生命周期事件。

## 自定义工具图标

在“工具与扩展 → 自定义工具”填写工具 ID、显示名、配置路径，可选填图标路径。也可“选择图标”或把一张本机图片拖到图标区域，自动填入路径并预览。支持 PNG、JPEG、WebP，单文件不超过 2MB；SVG 不作为自定义图片载入。

图标保留原文件位置，不复制、不上传；移动或删除原图后会提示路径失效。工具列表、任务来源和办公室使用相同的自定义图标。可编辑已有工具或清除图标，任务历史仍按工具 ID 保留。

自定义工具路径只用于安装识别；添加图标不会自动建立事件接入。

## 协议来源

- [DeepSeek session/event 与 turn/end](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)
- [OpenCode 插件](https://opencode.ai/docs/build/plugins/server/)及[事件 API](https://opencode.ai/docs/api)
- [Gemini CLI Hooks](https://geminicli.com/docs/hooks/reference/)
- [Qwen Code Hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)

内置图标取自各工具官方仓库：DeepSeek 蓝色鲸鱼标识 `deepseek-ai/DeepSeek-LLM/images/logo.svg`、Gemini CLI `packages/vscode-ide-companion/assets/icon.png`、Qwen Code `packages/desktop/bootstrap/qwen-code-logo.svg`、OpenCode `packages/desktop/icons/prod/icon.png`。对应仓库许可证随图标保存在 `assets/office/icons/*-LICENSE.txt`，标识版权归各自权利人。

MCP 配置参考：[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/)、[Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server/)、[OpenCode 2](https://opencode.ai/docs/mcp-servers)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)。
