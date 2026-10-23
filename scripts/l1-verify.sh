#!/usr/bin/env bash
# L1 验证完整执行三个检查，并通过退出状态报告任何失败。
set -u

cd "$(dirname "$0")/.." || exit 1
LOG_DIR=".verify"
LOG="$LOG_DIR/l1.log"
mkdir -p "$LOG_DIR" || exit 1
: > "$LOG" || exit 1
status=0

log() { echo "$*" >> "$LOG"; }

run_check() {
  name="$1"
  stage="$2"
  log "--- $stage $name ---"
  if pnpm "$name" >> "$LOG" 2>&1; then
    check_status=0
  else
    check_status=$?
    status=1
  fi
  log ">> $name exit=$check_status" || status=1
  log "" || status=1
}

log "=== L1 验证 $(date '+%Y-%m-%d %H:%M:%S') ==="
log "--- 运行环境 ---"
log "node: $(node -v 2>&1)"
log "pnpm: $(pnpm -v 2>&1)"
log ""

run_check typecheck 1/3
run_check test 2/3
run_check lint 3/3

log "=== 汇总 ==="
grep -E '^>> (typecheck|test|lint) exit=' "$LOG" || status=1
echo "日志已写入: $(pwd)/$LOG"
if [ "$status" -ne 0 ]; then
  echo "L1 验证失败，请检查日志。" >&2
else
  echo "L1 验证通过。"
fi
exit "$status"
