#!/usr/bin/env bash
# 部署脚本测试的公共库：断言计数 + 临时目录 + 桩命令注入 + 独立进程执行器。
# 断言只累计与打印，不立即退出；文件末尾调 finish，以失败数作为退出码。

ASSERT_PASS=0
ASSERT_FAIL=0

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$TESTS_DIR/.." && pwd)"
KH_TEST_SCRIPT="$DEPLOY_DIR/kanban-hub.sh"
export KH_TEST_SCRIPT
STUBS_DIR="$TESTS_DIR/fixtures/stubs"

pass() { ASSERT_PASS=$((ASSERT_PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { ASSERT_FAIL=$((ASSERT_FAIL + 1)); printf '  FAIL %s\n' "$1"; }

# assert_eq 描述 期望 实际
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1（期望 [$2]，实际 [$3]）"; fi
}

# assert_contains 描述 子串 整体
assert_contains() {
  case "$3" in
    *"$2"*) pass "$1" ;;
    *) fail "$1（未包含 [$2]）" ;;
  esac
}

# assert_not_contains 描述 子串 整体
assert_not_contains() {
  case "$3" in
    *"$2"*) fail "$1（不应包含 [$2]）" ;;
    *) pass "$1" ;;
  esac
}

# assert_rc 描述 期望退出码 实际退出码
assert_rc() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1（期望退出码 $2，实际 $3）"; fi
}

# assert_cond 描述 命令 [参数...]：命令返回 0 通过
assert_cond() {
  local d="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$d"; else fail "${d}（条件为假）"; fi
}

# assert_no_cond 描述 命令 [参数...]：命令非 0 通过
assert_no_cond() {
  local d="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "${d}（条件意外为真）"; else pass "$d"; fi
}

finish() {
  printf '%s：通过 %d，失败 %d\n' "${TEST_NAME:-test}" "$ASSERT_PASS" "$ASSERT_FAIL"
  [ "$ASSERT_FAIL" = 0 ]
}

# 真实路径的临时目录（macOS 的 TMPDIR 带 /var → /private/var 符号链接，统一解析掉）
temp_dir() {
  local d
  d=$(mktemp -d "${TMPDIR:-/tmp}/kh-test-XXXXXXXX")
  (cd "$d" && pwd -P) || printf '%s' "$d"
}

# 建一个 bin 目录，放入 fixtures/stubs 下指定的桩命令；返回该目录（调用方自行拼 PATH）
stub_bin() {
  local bin name
  bin="$(temp_dir)/bin"
  mkdir -p "$bin"
  for name in "$@"; do
    cp "$STUBS_DIR/$name" "$bin/$name"
    chmod 755 "$bin/$name"
  done
  printf '%s' "$bin"
}

# path_with 桩目录：把桩目录拼到 PATH 最前面并输出
path_with() {
  printf '%s:%s' "$1" "${PATH:-}"
}

# kh_run：在独立 bash 进程里 source 被测脚本后执行 body（经 KH_TEST_BODY 传入并 eval）。
# 该进程的 stdin 就是交互输入——脚本以 KH_TTY=- 启动，fd 9 沿用 stdin，
# 喂进去的预设答案正好被向导按行读走（当前 shell 里 fd 9 已被顶层 source 占用，不能复用）
kh_run() {
  KH_TEST_BODY="$1" bash -c '
    KH_SOURCE_ONLY=1
    KH_TTY=-
    KH_PLAIN=1
    NO_COLOR=1
    export KH_SOURCE_ONLY KH_TTY KH_PLAIN NO_COLOR
    # shellcheck disable=SC1090  # 被测脚本路径经环境变量注入
    . "$KH_TEST_SCRIPT"
    eval "$KH_TEST_BODY"
  '
}
