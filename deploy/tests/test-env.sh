#!/usr/bin/env bash
# 单测：.env 读写（env_set/env_get 往返、注释保留、引号与权限处理）与 state 文件
# shellcheck disable=SC2034,SC2016  # TEST_NAME 等供被测脚本与 finish 读取；kh_run 的 body 为单引号有意不在本进程展开
set -u
TEST_NAME="test-env"
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. "$(dirname "$0")/lib.sh"

KH_SOURCE_ONLY=1
KH_TTY=-
NO_COLOR=1
# shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
. "$KH_TEST_SCRIPT"

f="$(temp_dir)/.env"

# --- env_quote ---
assert_eq "env_quote 安全字符原样输出" "v1.0.0_beta" "$(env_quote 'v1.0.0_beta')"
assert_eq "env_quote 含空格时单引号包裹" "'a b'" "$(env_quote 'a b')"
assert_eq "env_quote 空值原样输出为空" "" "$(env_quote '')"

# --- env_valid_value ---
assert_cond "env_valid_value 接受普通值" env_valid_value 'normal-pass'
assert_no_cond "env_valid_value 拒绝单引号" env_valid_value "a'b"
assert_no_cond "env_valid_value 拒绝换行" env_valid_value "$(printf 'a\nb')"

# --- env_set / env_get 往返 ---
env_set "$f" KH_VERSION 1.0.0
assert_eq "env_set 后 env_get 读回简单值" "1.0.0" "$(env_get "$f" KH_VERSION)"

env_set "$f" KH_PUBLIC_URL 'http://192.168.1.20:28970'
assert_eq "env_set 往返保留 URL（含冒号斜杠）" "http://192.168.1.20:28970" "$(env_get "$f" KH_PUBLIC_URL)"

env_set "$f" NOTE 'x $y #z'
assert_eq "env_set 往返保留 $ 与 # 字面量" 'x $y #z' "$(env_get "$f" NOTE)"

env_set "$f" QUOTED 'has space'
assert_eq "env_get 剥掉写入时的包裹引号" 'has space' "$(env_get "$f" QUOTED)"

# --- 行尾注释 ---
printf 'A=plain # 注释\n' >"$f"
assert_eq "env_get 去掉未加引号值的行尾注释" "plain" "$(env_get "$f" A)"

# --- 重复键：替换首个、删掉其余；其他行与注释原样保留 ---
printf '# 头部注释\nK=1\nX=keep\n# 中间注释\nK=3\n' >"$f"
env_set "$f" K 9
assert_eq "重复键替换首个并删其余（其余行不重排）" '# 头部注释
K=9
X=keep
# 中间注释' "$(cat "$f")"

# --- 缺键追加；文件缺结尾换行也能接上 ---
printf 'A=1' >"$f"
env_set "$f" B 2
assert_eq "缺键追加到末尾（文件无结尾换行时先补）" 'A=1
B=2' "$(cat "$f")"

# --- 非法值：返回 2 且文件不变 ---
printf 'A=1\n' >"$f"
before=$(cat "$f")
env_set "$f" BAD "can't" 2>/dev/null
assert_rc "含单引号的值被拒绝（返回 2）" 2 "$?"
assert_eq "被拒绝时文件保持原样" "$before" "$(cat "$f")"

# --- 权限与属主保持：cat > 原地写回 ---
umask 022
printf 'A=1\n' >"$f"
chmod 600 "$f"
env_set "$f" B 2
mode=$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")
assert_eq "原地写回保留原文件权限（600）" "600" "$mode"

# --- env_get：取最后一次出现；缺键返回 1 ---
printf 'V=old\nV=new\n' >"$f"
assert_eq "env_get 取最后一次出现的值" "new" "$(env_get "$f" V)"
env_get "$f" NO_SUCH_KEY >/dev/null 2>&1
assert_rc "缺键返回 1" 1 "$?"

# --- env_missing_keys ---
printf 'KH_VERSION=1.0.0\n' >"$f"
assert_eq "env_missing_keys 列出缺失键" "KH_ADMIN_PASSWORD" "$(env_missing_keys "$f" KH_VERSION KH_ADMIN_PASSWORD)"
rc=0
env_missing_keys "$f" KH_VERSION KH_ADMIN_PASSWORD >/dev/null || rc=$?
assert_rc "env_missing_keys 有缺失时返回 1" 1 "$rc"
printf 'KH_VERSION=1.0.0\nKH_ADMIN_PASSWORD=x\n' >"$f"
env_missing_keys "$f" KH_VERSION KH_ADMIN_PASSWORD >/dev/null
assert_rc "必填项齐全时返回 0" 0 "$?"

# --- state 文件 ---
KH_HOME="$(temp_dir)"
state_set compose_sha256 abc123
state_set template_version 3
assert_eq "state_set/state_get 往返" "abc123" "$(state_get compose_sha256)"
assert_eq "state 文件路径为 .kanban-hub-state" "abc123" "$(env_get "$KH_HOME/.kanban-hub-state" compose_sha256)"
assert_eq "state 第二个键互不干扰" "3" "$(state_get template_version)"
state_set compose_sha256 def456
assert_eq "state_set 原地覆盖" "def456" "$(state_get compose_sha256)"

finish
