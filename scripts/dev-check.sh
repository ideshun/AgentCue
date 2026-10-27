#!/usr/bin/env bash
# dev-check：一条命令回答「AgentCue 能不能起来」。
#
# 分四步，全部输出落盘到 .verify/dev.log（Electron 运行输出单独落 .verify/smoke.log）：
#   1/4 全量构建（5 个 workspace 包，幂等）
#   2/4 产物完整性（dist 关键文件 + better-sqlite3 编译产物）
#   3/4 原生模块 ABI（用 Electron 自带 Node require better-sqlite3）
#   4/4 应用 smoke（清残留实例 → 后台启动 → 存活 25 秒判定成功）
#
# 用法：sh scripts/dev-check.sh
# 日志由 AI 直接读取定位问题，无需人工复制粘贴终端输出。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

LOG_DIR="$ROOT/.verify"
LOG="$LOG_DIR/dev.log"
SMOKE="$LOG_DIR/smoke.log"
mkdir -p "$LOG_DIR"
: > "$LOG"
: > "$SMOKE"

log() { echo "$*" >> "$LOG"; }

log "=== dev-check $(date '+%Y-%m-%d %H:%M:%S') ==="
log "pwd: $ROOT"
log "node: $(node -v 2>&1)"
log "pnpm: $(pnpm -v 2>&1)"
log ""

# ---------- 0/4 依赖补装（缺啥补啥，镜像走 npmmirror，全部幂等） ----------
log "--- 0/4 依赖补装 ---"

# 0a. workspace 链接：后加的 workspace:* 依赖需要重新 install 才会生成链接（hoisted 布局看根 node_modules）
if [ ! -e "$ROOT/node_modules/@awm/core" ] || [ ! -e "$ROOT/node_modules/@awm/adapters" ]; then
  log "workspace 链接缺失（根 node_modules/@awm/core 或 @awm/adapters），执行 pnpm install"
  pnpm install >> "$LOG" 2>&1
  log ">> pnpm install exit=$?"
else
  log "workspace 链接完整，跳过 install"
fi

# 0b. Electron 二进制：postinstall 下载被墙时会缺失，用 npmmirror 补拉
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  log "Electron 二进制缺失，走 npmmirror 重新下载"
  (
    cd "$ROOT/node_modules/electron" || exit 1
    ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js
  ) >> "$LOG" 2>&1
  log ">> electron install.js exit=$?"
else
  log "Electron 二进制已存在，跳过下载"
fi

# 0c. better-sqlite3：按 Electron ABI rebuild（prebuilt 下载失败时退回 node-gyp 本地编译）
BS3_GLOB="$(ls "$ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node "$ROOT"/node_modules/better-sqlite3/build/Release/better_sqlite3.node 2>/dev/null | head -1)"
if [ -z "$BS3_GLOB" ]; then
  log "better-sqlite3 编译产物缺失，执行 electron-builder install-app-deps"
  (
    cd "$ROOT/apps/desktop" || exit 1
    ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npx electron-builder install-app-deps
  ) >> "$LOG" 2>&1
  log ">> install-app-deps exit=$?"
else
  log "better-sqlite3 编译产物已存在（${BS3_GLOB}），跳过 rebuild"
fi
log ""

# ---------- 1/4 全量构建 ----------
log "--- 1/4 pnpm build（全量）---"
pnpm build >> "$LOG" 2>&1
log ">> build exit=$?"
log ""

# ---------- 2/4 产物完整性 ----------
log "--- 2/4 产物检查 ---"
for f in \
  packages/schema/dist/index.js \
  packages/store/dist/index.js \
  packages/core/dist/index.js \
  packages/adapters/dist/index.js \
  apps/desktop/dist/main/index.js \
  apps/desktop/dist/preload/index.js \
  apps/desktop/dist/renderer/index.html \
  apps/desktop/dist/renderer/app.js \
  apps/desktop/dist/resources/adapters/claude-code/manifest.yaml; do
  if [ -f "$ROOT/$f" ]; then
    log "OK   $f"
  else
    log "MISS $f"
  fi
done

BS3="$(ls "$ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node "$ROOT"/node_modules/better-sqlite3/build/Release/better_sqlite3.node 2>/dev/null | head -1)"
if [ -n "$BS3" ]; then
  log "OK   native: $BS3"
else
  log "MISS better-sqlite3 编译产物（build/Release/better_sqlite3.node）"
fi
log ""

# ---------- 3/4 原生模块 ABI ----------
log "--- 3/4 Electron ABI（require better-sqlite3）---"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON" ]; then
  ELECTRON="$ROOT/node_modules/.bin/electron"
fi
log "electron: $ELECTRON"
(
  cd "$ROOT/packages/store" || exit 1
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e "try { require('better-sqlite3'); console.log('ABI_OK node=' + process.versions.node + ' abi=' + process.versions.modules); } catch (e) { console.log('ABI_FAIL ' + e.message); process.exit(1); }"
) >> "$LOG" 2>&1
log ">> abi exit=$?"
log ""

# ---------- 4/4 应用 smoke ----------
log "--- 4/4 应用 smoke（启动后存活 25s 判定成功）---"
RUNTIME="$HOME/Library/Application Support/AIWorkflowMonitor/runtime.json"
if [ -f "$RUNTIME" ]; then
  OLD_PID="$(/usr/bin/python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid',''))" "$RUNTIME" 2>/dev/null)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "发现残留实例 pid=${OLD_PID}，先结束（避免单实例锁导致新进程立即退出）"
    kill "$OLD_PID" 2>/dev/null
    sleep 1
  fi
fi

cd "$ROOT/apps/desktop" || exit 1
"$ELECTRON" . >> "$SMOKE" 2>&1 &
EPID=$!
sleep 25
if kill -0 "$EPID" 2>/dev/null; then
  log ">> smoke OK：应用存活（主进程 + 窗口已拉起）"
  kill "$EPID" 2>/dev/null
  sleep 1
  kill -9 "$EPID" 2>/dev/null
else
  log ">> smoke FAIL：进程提前退出，Electron 输出见 .verify/smoke.log"
fi
cd "$ROOT" || exit 1

log ""
SUMMARY="$(grep -E '^>> ' "$LOG" 2>/dev/null || true)"
log "=== 汇总 ==="
log "$SUMMARY"
echo "完成。日志：$LOG"
echo "Electron 运行输出：$SMOKE"
