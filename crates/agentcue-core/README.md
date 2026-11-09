# AgentCue Rust 核心

这是 1.0 迁移的第一个模块，当前提供与 Electron 版本一致的任务状态取值、事件类型、迁移裁决与内存状态恢复；没有运行时依赖。

桌面目标已确定为 **Rust + Tauri 2**。本 crate 不依赖 UI，不启动扫描、语音或 HTTP 服务，也不打开真实用户数据库。持久化、事件去重、采集检查点和播报仍由现有 Electron 引擎提供，尚未迁移到这里。

## 开发与验证

安装官方 rustup 后，在仓库根目录运行：

```sh
pnpm rust:verify
```

该命令依次检查格式、Clippy 与 Rust 测试。`Cargo.lock` 固定工作区依赖；本 crate 没有第三方依赖，工作区中的存储模块首次运行需要下载 SQLite 依赖。测试不需要访问用户文件或生产数据库。

`tests/fixtures/transitions.tsv` 从现有 `@awm/schema` 和 `@awm/core` 导出。Rust 测试穷举所有 84 种状态／事件组合；现有 Vitest 契约测试同时检查夹具仍与 TS 实现一致。修改迁移表后，运行：

```sh
pnpm rust:contract
pnpm rust:verify
```

更新夹具后，若 Rust 行为尚未跟进，Rust 测试仍会失败。不要通过修改夹具绕过现有 TS 契约。

迁移顺序和兼容边界见 [ADR-21](../../docs/adr/ADR-21-rust-tauri-migration.md)。
