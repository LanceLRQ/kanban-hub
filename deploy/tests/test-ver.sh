#!/usr/bin/env bash
# 单测：版本比较（ver_cmp）、正式版挑选（ver_latest_stable）、Docker Hub tags 解析与联网查询
# shellcheck disable=SC2034,SC2016  # TEST_NAME 等供被测脚本与 finish 读取；kh_run 的 body 为单引号有意不在本进程展开
set -u
TEST_NAME="test-ver"
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. "$(dirname "$0")/lib.sh"

KH_SOURCE_ONLY=1
KH_TTY=-
NO_COLOR=1
# shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
. "$KH_TEST_SCRIPT"

# --- ver_cmp ---
assert_eq "ver_cmp 相等" "0" "$(ver_cmp 1.0.0 1.0.0)"
assert_eq "ver_cmp 大于" "1" "$(ver_cmp 0.2.0 0.1.9)"
assert_eq "ver_cmp 小于" "-1" "$(ver_cmp 0.1.9 0.2.0)"
assert_eq "ver_cmp 去掉 v 前缀" "0" "$(ver_cmp v1.0.0 1.0.0)"
assert_eq "ver_cmp 缺段补 0" "0" "$(ver_cmp 0.1 0.1.0)"
assert_eq "ver_cmp 逐段数值比较（10 > 9）" "1" "$(ver_cmp 1.10.0 1.9.9)"
assert_eq "ver_cmp 预发布低于正式版" "-1" "$(ver_cmp 1.0.0-rc.1 1.0.0)"
assert_eq "ver_cmp 预发布按字典序" "-1" "$(ver_cmp 1.0.0-alpha 1.0.0-beta)"
assert_eq "ver_cmp rc 高于 beta" "1" "$(ver_cmp 1.0.0-rc.1 1.0.0-beta)"
assert_eq "ver_cmp 主体相同预发布相等" "0" "$(ver_cmp 1.0.0-rc.1 1.0.0-rc.1)"

# --- ver_latest_stable ---
assert_eq "ver_latest_stable 跳过 latest 与预发布取最大正式版" "0.2.0" \
  "$(printf '%s\n' latest 0.1.0 0.3.0-rc.1 0.2.0 | ver_latest_stable)"
assert_eq "ver_latest_stable 容忍 v 前缀" "1.2.0" \
  "$(printf '%s\n' v1.2.0 0.9.0 | ver_latest_stable)"
printf '%s\n' latest dev | ver_latest_stable >/dev/null
assert_rc "ver_latest_stable 无正式版返回 1" 1 "$?"

# --- hub_tags_parse ---
assert_eq "hub_tags_parse 提取 tag 名" "0.1.0
dev" \
  "$(printf '{"count":2,"results":[{"name":"0.1.0"},{"name": "dev"}]}' | hub_tags_parse)"

# --- fetch_latest_version：curl 桩提供 tags JSON，不访问外网 ---
BIN=$(stub_bin curl)
TAGS='{"results":[{"name":"0.1.0"},{"name":"0.3.0-rc.1"},{"name":"0.2.0"}]}'
r=$(PATH=$(path_with "$BIN") STUB_CURL_BODY="$TAGS" KH_HUB_TAGS_URL="http://stub.example/tags" fetch_latest_version 5)
assert_eq "fetch_latest_version 取联网结果的最大正式版" "0.2.0" "$r"
r=$(PATH=$(path_with "$BIN") STUB_CURL_EXIT=7 KH_HUB_TAGS_URL="http://stub.example/tags" fetch_latest_version 5)
assert_rc "fetch_latest_version 网络失败返回 1" 1 "$?"

finish
