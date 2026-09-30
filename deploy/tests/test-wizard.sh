#!/usr/bin/env bash
# 单测：向导默认值与校验器；交互型 choose_* 用预设答案驱动（KH_TTY=- 沿用 stdin）
# shellcheck disable=SC2034,SC2016  # TEST_NAME 等供被测脚本与 finish 读取；kh_run 的 body 为单引号有意不在本进程展开
set -u
TEST_NAME="test-wizard"
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. "$(dirname "$0")/lib.sh"

KH_SOURCE_ONLY=1
KH_TTY=-
NO_COLOR=1
KH_PLAIN=1
# shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
. "$KH_TEST_SCRIPT"

BIN=$(stub_bin hostname ss ip timedatectl)

# --- 版本常量 ---
case "$KH_SCRIPT_VERSION" in
  [0-9]*.[0-9]*.[0-9]*) pass "KH_SCRIPT_VERSION 是 X.Y.Z（${KH_SCRIPT_VERSION}）" ;;
  *) fail "KH_SCRIPT_VERSION 是 X.Y.Z（实际 [$KH_SCRIPT_VERSION]）" ;;
esac
case "$KH_TEMPLATE_VERSION" in
  ''|*[!0-9]*) fail "KH_TEMPLATE_VERSION 是数字（实际 [$KH_TEMPLATE_VERSION]）" ;;
  *) pass "KH_TEMPLATE_VERSION 是数字（${KH_TEMPLATE_VERSION}）" ;;
esac

# --- wizard_defaults ---
wizard_defaults
assert_eq "向导默认端口 28970" "28970" "$W_PORT"
assert_eq "向导默认监听所有网卡" "0.0.0.0" "$W_BIND"
assert_eq "向导默认镜像来源 Hub" "hub" "$W_IMAGE_SOURCE"
assert_eq "向导默认镜像名留空（用模板默认值）" "" "$W_IMAGE"
assert_eq "向导默认版本为脚本自身版本" "$KH_SCRIPT_VERSION" "$W_VERSION"
assert_eq "向导默认运行身份为当前用户" "$(id -u):$(id -g)" "$W_PUID:$W_PGID"
assert_eq "向导默认密码为空" "" "$W_PASSWORD"
assert_eq "向导默认对外地址为空" "" "$W_PUBLIC_URL"

# --- public_url_default：按局域网 IP 推断 ---
r=$(PATH=$(path_with "$BIN") STUB_IPS="192.168.1.20 10.0.0.5" public_url_default 0.0.0.0 28970)
assert_eq "对外地址默认按第一个局域网 IP 推断" "http://192.168.1.20:28970" "$r"
r=$(PATH=$(path_with "$BIN") STUB_IPS="192.168.1.20" public_url_default "" 31000)
assert_eq "对外地址默认带上传入端口" "http://192.168.1.20:31000" "$r"
r=$(PATH=$(path_with "$BIN") STUB_IPS="192.168.1.20" public_url_default 127.0.0.1 28970)
assert_eq "仅本机监听时对外地址默认留空" "" "$r"
r=$(PATH=$(path_with "$BIN") STUB_IPS="" public_url_default 0.0.0.0 28970)
assert_eq "拿不到局域网 IP 时留空" "" "$r"

# --- 校验器 ---
assert_cond "valid_port 接受常规端口" valid_port 28970
assert_no_cond "valid_port 拒绝 0" valid_port 0
assert_no_cond "valid_port 拒绝 65536" valid_port 65536
assert_no_cond "valid_port 拒绝空值" valid_port ""
assert_no_cond "valid_port 拒绝非数字" valid_port abc

assert_cond "valid_ipv4 接受常规地址" valid_ipv4 192.168.1.20
assert_no_cond "valid_ipv4 拒绝超 255 段" valid_ipv4 256.1.1.1
assert_no_cond "valid_ipv4 拒绝三段" valid_ipv4 1.2.3
assert_no_cond "valid_ipv4 拒绝非数字" valid_ipv4 a.b.c.d

assert_cond "valid_public_url 空值合法（自动识别）" valid_public_url ""
assert_cond "valid_public_url 接受 http" valid_public_url "http://192.168.1.20:28970"
assert_cond "valid_public_url 接受 https 带路径" valid_public_url "https://kh.example.com/p"
assert_no_cond "valid_public_url 拒绝 ftp" valid_public_url "ftp://kh.example.com"
assert_no_cond "valid_public_url 拒绝裸主机名" valid_public_url "kh.example.com"
assert_no_cond "valid_public_url 拒绝含空格" valid_public_url "http://a b"
assert_no_cond "valid_public_url 拒绝含单引号" valid_public_url "http://a'b"

# --- detect_timezone ---
ETC="$(temp_dir)/etc"
mkdir -p "$ETC"
printf 'Asia/Shanghai\n' >"$ETC/timezone"
assert_eq "detect_timezone 读 /etc/timezone" "Asia/Shanghai" "$(PATH=$(path_with "$BIN") KH_ETC="$ETC" detect_timezone)"
rm -f "$ETC/timezone"
assert_eq "detect_timezone 拿不到时按 UTC" "UTC" "$(PATH=$(path_with "$BIN") KH_ETC="$ETC" detect_timezone)"
assert_eq "detect_timezone 读 timedatectl" "Europe/Berlin" "$(PATH=$(path_with "$BIN") STUB_TIMEZONE=Europe/Berlin KH_ETC="$ETC" detect_timezone)"

# --- choose_password：留空随机生成，只此一次标记 ---
r=$(printf '\n' | PATH=$(path_with "$BIN") kh_run 'choose_password >/dev/null 2>&1; printf "%s|%s|%s" "${#W_PASSWORD}" "$W_PASSWORD_GENERATED" "$(printf "%s" "$W_PASSWORD" | tr -d "A-Za-z0-9")"')
assert_eq "密码留空则随机生成 20 位字母数字且标记 generated" "20|1|" "$r"

r=$(printf 'pass-12345\npass-99999\n' | PATH=$(path_with "$BIN") kh_run 'choose_password >/dev/null 2>&1; printf "%s" "$W_PASSWORD"')
assert_eq "两次输入不一致时重问" "" "$r"

r=$(printf 'pass-12345\npass-12345\n' | PATH=$(path_with "$BIN") kh_run 'choose_password >/dev/null 2>&1; printf "%s|%s" "$W_PASSWORD" "$W_PASSWORD_GENERATED"')
assert_eq "两次输入一致则采用" "pass-12345|0" "$r"

r=$(printf 'short\npass-12345\npass-12345\n' | PATH=$(path_with "$BIN") kh_run 'choose_password >/dev/null 2>&1; printf "%s|%s" "$W_PASSWORD" "$W_PASSWORD_GENERATED"')
assert_eq "密码过短时重问，通过后采用" "pass-12345|0" "$r"

# --- choose_port：非法值与占用端口都会重问 ---
r=$(printf '70000\nabc\n31000\n' | PATH=$(path_with "$BIN") kh_run 'choose_port >/dev/null 2>&1; printf "%s" "$W_PORT"')
assert_eq "choose_port 跳过非法值后采用合法端口" "31000" "$r"

r=$(printf '31000\n' | PATH=$(path_with "$BIN") STUB_SS_TABLE='LISTEN 0 128 0.0.0.0:31000 *:*' kh_run 'wizard_defaults; choose_port >/dev/null 2>&1; printf "%s" "$W_PORT"')
assert_eq "choose_port 拒绝被占用端口（重问后采用默认）" "28970" "$r"

r=$(printf '28970\n' | PATH=$(path_with "$BIN") STUB_SS_TABLE='LISTEN 0 128 0.0.0.0:28970 *:*' kh_run 'wizard_defaults; choose_port 28970 >/dev/null 2>&1; printf "%s" "$W_PORT"')
assert_eq "choose_port 允许参数指定的端口（容器自己占用的场景）" "28970" "$r"

# --- choose_bind ---
r=$(printf '2\n' | PATH=$(path_with "$BIN") kh_run 'choose_bind >/dev/null 2>&1; printf "%s" "$W_BIND"')
assert_eq "choose_bind 选仅本机" "127.0.0.1" "$r"

r=$(printf '3\n999.1.1.1\n10.0.0.2\n' | PATH=$(path_with "$BIN") kh_run 'choose_bind >/dev/null 2>&1; printf "%s" "$W_BIND"')
assert_eq "choose_bind 自定义 IPv4（非法地址重问）" "10.0.0.2" "$r"

# --- choose_identity ---
r=$(printf '2\n' | PATH=$(path_with "$BIN") kh_run 'choose_identity >/dev/null 2>&1; printf "%s:%s" "$W_PUID" "$W_PGID"')
assert_eq "choose_identity 选 1000:1000" "1000:1000" "$r"

r=$(printf '4\n7:7\n' | PATH=$(path_with "$BIN") kh_run 'choose_identity >/dev/null 2>&1; printf "%s:%s" "$W_PUID" "$W_PGID"')
assert_eq "choose_identity 自定义 UID:GID" "7:7" "$r"

# --- choose_timezone ---
r=$(printf '\n' | PATH=$(path_with "$BIN") kh_run 'W_TZ=Asia/Shanghai; choose_timezone >/dev/null 2>&1; printf "%s" "$W_TZ"')
assert_eq "choose_timezone 回车采用默认" "Asia/Shanghai" "$r"

r=$(printf 'Bad TZ\nAsia/Shanghai\n' | PATH=$(path_with "$BIN") kh_run 'choose_timezone >/dev/null 2>&1; printf "%s" "$W_TZ"')
assert_eq "choose_timezone 拒绝含空格的时区" "Asia/Shanghai" "$r"

# --- choose_public_url ---
r=$(printf '\n' | PATH=$(path_with "$BIN") STUB_IPS="192.168.1.20" kh_run 'wizard_defaults; choose_public_url >/dev/null 2>&1; printf "%s" "$W_PUBLIC_URL"')
assert_eq "choose_public_url 回车采用推断的默认值" "http://192.168.1.20:28970" "$r"

r=$(printf 'ftp://x\nhttps://kb.example.com\n' | PATH=$(path_with "$BIN") kh_run 'choose_public_url >/dev/null 2>&1; printf "%s" "$W_PUBLIC_URL"')
assert_eq "choose_public_url 拒绝非 http(s) 后采用合法值" "https://kb.example.com" "$r"

# 已存值优先于推断值：config 修改场景直接回车不能悄悄换成推断地址
r=$(printf '\n' | PATH=$(path_with "$BIN") STUB_IPS="192.168.1.20" kh_run 'W_PUBLIC_URL="https://kb.example.com"; choose_public_url >/dev/null 2>&1; printf "%s" "$W_PUBLIC_URL"')
assert_eq "choose_public_url 回车沿用已存值" "https://kb.example.com" "$r"

# 输入 - 是唯一显式清空入口：断言带哨兵前缀，避免与初值空串混淆成空洞通过
r=$(printf -- '-\n' | PATH=$(path_with "$BIN") kh_run 'W_PUBLIC_URL="https://kb.example.com"; choose_public_url >/dev/null 2>&1; printf "rc=%s url=[%s]" "$?" "$W_PUBLIC_URL"')
assert_eq "choose_public_url 输入 - 显式清空已存值" "rc=0 url=[]" "$r"

# --- choose_image：非仓库目录只有 Hub 项；仓库目录多出本地构建项 ---
r=$(printf '1\n' | PATH=$(path_with "$BIN") kh_run 'choose_image >/dev/null 2>&1; printf "%s|%s|%s" "$W_IMAGE" "$W_VERSION" "$W_IMAGE_SOURCE"')
assert_eq "choose_image 默认 Hub 镜像（镜像名留空）" "|$KH_SCRIPT_VERSION|hub" "$r"

REPO="$(temp_dir)/repo"
mkdir -p "$REPO"
printf 'FROM scratch\n' >"$REPO/Dockerfile"
printf '{"name":"kanban-hub"}\n' >"$REPO/package.json"
r=$(cd "$REPO" && printf '2\n' | PATH=$(path_with "$BIN") kh_run 'choose_image >/dev/null 2>&1; printf "%s|%s|%s" "$W_IMAGE" "$W_VERSION" "$W_IMAGE_SOURCE"')
assert_eq "仓库目录下选本地构建" "kanban-hub|dev|build" "$r"

printf '{"name":"other"}\n' >"$REPO/package.json"
r=$(cd "$REPO" && printf '1\n' | PATH=$(path_with "$BIN") kh_run 'choose_image >/dev/null 2>&1; printf "%s|%s" "$W_IMAGE" "$W_IMAGE_SOURCE"')
assert_eq "name 不符的目录不出现构建选项" "|hub" "$r"

# --- wizard_summary：选中某项回头修改后确认 ---
r=$(printf '4\n31000\n1\n' | PATH=$(path_with "$BIN") kh_run 'wizard_defaults; wizard_summary >/dev/null 2>&1; printf "rc=%s port=%s" "$?" "$W_PORT"')
assert_eq "汇总页可回头改端口再确认" "rc=0 port=31000" "$r"

r=$(printf '9\n' | PATH=$(path_with "$BIN") kh_run 'wizard_defaults; wizard_summary >/dev/null 2>&1; printf "rc=%s" "$?"')
assert_eq "汇总页选取消返回 1" "rc=1" "$r"

finish
