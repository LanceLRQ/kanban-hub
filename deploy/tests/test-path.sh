#!/usr/bin/env bash
# 单测：路径与通用工具（危险路径黑名单、abs_path、sh_quote、属主、随机密码、容量格式化）
# shellcheck disable=SC2034,SC2016  # TEST_NAME 等供被测脚本与 finish 读取；kh_run 的 body 为单引号有意不在本进程展开
set -u
TEST_NAME="test-path"
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. "$(dirname "$0")/lib.sh"

KH_SOURCE_ONLY=1
KH_TTY=-
NO_COLOR=1
# shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
. "$KH_TEST_SCRIPT"

# --- path_forbidden：0 = 禁止，1 = 可用 ---
for p in "" / "$HOME" .. /opt /usr /usr/local /usr/kanban-hub /home /root /etc /var /bin /srv /mnt /media /data /tmp /proc /sys /dev /run "/a/../b" "/a/.."; do
  assert_cond "危险路径禁止用作安装目录：[$p]" path_forbidden "$p"
done
for p in /opt/kanban-hub /opt/kh/test /srv/kanban-hub /home/user/kanban-hub /data/kanban-hub /mnt/deploy/kh; do
  assert_no_cond "普通路径允许用作安装目录：[$p]" path_forbidden "$p"
done

# --- abs_path ---
assert_eq "abs_path 去掉 /./ 与末尾斜杠" "/a/b" "$(abs_path /a/./b/)"
assert_eq "abs_path 相对路径拼上 PWD" "$PWD/rel" "$(abs_path rel)"
assert_eq "abs_path 展开 ~" "$HOME" "$(abs_path ~)"
assert_eq "abs_path 展开 ~/x" "$HOME/x" "$(abs_path ~/x)"
assert_eq "abs_path 根目录保持 /" "/" "$(abs_path /)"
assert_eq "abs_path 已是绝对路径原样返回" "/opt/kanban-hub" "$(abs_path /opt/kanban-hub)"

# --- sh_quote ---
assert_eq "sh_quote 简单串" "'abc'" "$(sh_quote abc)"
assert_eq "sh_quote 转义内部单引号" "'a'\\''b'" "$(sh_quote "a'b")"

# --- stat_owner：uid:gid 数字格式 ---
owner=$(stat_owner "$(temp_dir)")
case "$owner" in
  [0-9]*:[0-9]*) pass "stat_owner 输出 uid:gid 数字格式（${owner}）" ;;
  *) fail "stat_owner 输出 uid:gid 数字格式（实际 [$owner]）" ;;
esac
stat_owner /nonexistent/path >/dev/null 2>&1
assert_rc "stat_owner 路径不存在返回 1" 1 "$?"

# --- gen_password ---
assert_eq "gen_password 指定长度" "12" "$(gen_password 12 | tr -d '\n' | wc -c | tr -d ' ')"
assert_eq "gen_password 默认 20 位" "20" "$(gen_password | tr -d '\n' | wc -c | tr -d ' ')"
p=$(gen_password 32)
case "$p" in
  *[!A-Za-z0-9]*|'') fail "gen_password 只含字母数字（实际 [$p]）" ;;
  *) pass "gen_password 只含字母数字" ;;
esac

# --- fmt_kb ---
assert_eq "fmt_kb KB 原样" "1K" "$(fmt_kb 1)"
assert_eq "fmt_kb 1024KB 一位小数" "1.0M" "$(fmt_kb 1024)"
assert_eq "fmt_kb 1.5M" "1.5M" "$(fmt_kb 1536)"
assert_eq "fmt_kb ≥10 取整" "10M" "$(fmt_kb 10240)"
assert_eq "fmt_kb 2G" "2.0G" "$(fmt_kb $((2 * 1024 * 1024)))"

finish
