#!/usr/bin/env bash
# 单测：内嵌 compose 模板、模板校验和记录、.env 生成与 apply_install 产物
# shellcheck disable=SC2034,SC2016  # TEST_NAME 等供被测脚本与 finish 读取；kh_run 的 body 为单引号有意不在本进程展开
set -u
TEST_NAME="test-template"
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. "$(dirname "$0")/lib.sh"

KH_SOURCE_ONLY=1
KH_TTY=-
NO_COLOR=1
# shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
. "$KH_TEST_SCRIPT"

# --- 模板内容与仓库 deploy/docker-compose.yml 语义一致（无 build 段，用现成镜像）---
tpl=$(tpl_compose)
assert_contains "模板镜像行用 Hub 默认名与 KH_VERSION 强制校验" \
  'image: ${KH_IMAGE:-lancelrq/kanban-hub}:${KH_VERSION:?请在 .env 设置 KH_VERSION}' "$tpl"
assert_contains "模板容器名" "container_name: kanban-hub" "$tpl"
assert_contains "模板运行身份取 PUID/PGID" 'user: "${PUID:-1000}:${PGID:-1000}"' "$tpl"
assert_contains "模板端口映射" '"${KH_BIND:-0.0.0.0}:${KH_PORT:-28970}:28970"' "$tpl"
assert_contains "模板挂载数据目录" "- ./data:/data" "$tpl"
assert_contains "模板挂载备份目录" "- ./backups:/backups" "$tpl"
assert_contains "模板注入管理员密码（缺置时报错）" 'KH_ADMIN_PASSWORD=${KH_ADMIN_PASSWORD:?请在 .env 设置 KH_ADMIN_PASSWORD}' "$tpl"
assert_contains "模板注入对外地址" 'KH_PUBLIC_URL=${KH_PUBLIC_URL:-}' "$tpl"
assert_contains "模板注入停滞天数" 'KH_STALE_DAYS=${KH_STALE_DAYS:-7}' "$tpl"
assert_contains "模板注入时区" 'TZ=${TZ:-Asia/Shanghai}' "$tpl"
assert_contains "模板注入权限掩码" 'UMASK=${UMASK:-022}' "$tpl"
assert_contains "模板 healthcheck 走 /api/health" "fetch('http://127.0.0.1:28970/api/health')" "$tpl"
assert_not_contains "模板没有 build 段（用现成镜像）" "build:" "$tpl"
assert_not_contains "模板不挂载 docker.sock" "docker.sock" "$tpl"

# --- write_templates：落盘并记录校验和与模板版本 ---
KH_HOME="$(temp_dir)"
mkdir -p "$KH_HOME"
write_templates
assert_eq "state 记录的校验和与文件一致" "$(sha256_file "$KH_HOME/docker-compose.yml")" "$(state_get compose_sha256)"
assert_eq "state 记录模板版本" "$KH_TEMPLATE_VERSION" "$(state_get template_version)"
printf '# 手改\n' >>"$KH_HOME/docker-compose.yml"
assert_no_cond "手改后校验和不再匹配（doctor 据此发现）" \
  test "$(sha256_file "$KH_HOME/docker-compose.yml")" = "$(state_get compose_sha256)"

# --- apply_install：全部产物一次落齐（Hub 镜像）---
KH_HOME="$(temp_dir)"
mkdir -p "$KH_HOME"
wizard_defaults
W_PASSWORD='secret-pass-1'
W_TZ='Asia/Shanghai'
W_PUBLIC_URL='http://192.168.1.20:28970'
apply_install >/dev/null 2>&1
assert_rc "apply_install 成功" 0 "$?"
for p in data backups .env docker-compose.yml .kanban-hub-state; do
  assert_cond "apply_install 产出 $p" test -e "$KH_HOME/$p"
done
mode=$(stat -c '%a' "$KH_HOME/.env" 2>/dev/null || stat -f '%Lp' "$KH_HOME/.env")
assert_eq ".env 权限 600" "600" "$mode"
assert_eq ".env 写入管理员密码" "secret-pass-1" "$(env_get "$KH_HOME/.env" KH_ADMIN_PASSWORD)"
assert_eq ".env 写入端口" "28970" "$(env_get "$KH_HOME/.env" KH_PORT)"
assert_eq ".env Hub 镜像名留空（用模板默认）" "" "$(env_get "$KH_HOME/.env" KH_IMAGE)"
assert_eq ".env 版本为脚本版本" "$KH_SCRIPT_VERSION" "$(env_get "$KH_HOME/.env" KH_VERSION)"
assert_eq ".env 运行身份为当前用户" "$(id -u)" "$(env_get "$KH_HOME/.env" PUID)"
assert_eq ".env 对外地址" "http://192.168.1.20:28970" "$(env_get "$KH_HOME/.env" KH_PUBLIC_URL)"
assert_eq ".env 时区" "Asia/Shanghai" "$(env_get "$KH_HOME/.env" TZ)"
assert_eq "state 记录镜像来源" "hub" "$(state_get image_source)"
assert_cond "state 记录安装时间" test -n "$(state_get installed_at)"
assert_eq "state 记录的校验和与 compose 文件一致" \
  "$(sha256_file "$KH_HOME/docker-compose.yml")" "$(state_get compose_sha256)"
assert_rc "apply_install 可重复执行（改配置后重写）" 0 "$({ apply_install >/dev/null 2>&1; echo $?; })"

# --- 本地构建来源：镜像名落盘，image_source 记 build ---
KH_HOME="$(temp_dir)"
mkdir -p "$KH_HOME"
wizard_defaults
W_IMAGE='kanban-hub'
W_VERSION='dev'
W_IMAGE_SOURCE='build'
W_PASSWORD='secret-pass-2'
apply_install >/dev/null 2>&1
assert_eq "本地构建镜像名写入 .env" "kanban-hub" "$(env_get "$KH_HOME/.env" KH_IMAGE)"
assert_eq "本地构建来源记入 state" "build" "$(state_get image_source)"
assert_eq "image_ref 拼出本地镜像引用" "kanban-hub:dev" "$(image_ref "$KH_HOME/.env")"
assert_no_cond "image_is_hub 对本地镜像返回假" image_is_hub "$KH_HOME/.env"

printf 'KH_IMAGE=\n' >"$KH_HOME/hub.env"
assert_cond "image_is_hub 对空镜像名返回真" image_is_hub "$KH_HOME/hub.env"

# --- 含特殊字符的值：单引号包裹写出、原样读回（compose 对单引号值不做插值）---
printf 'KH_ADMIN_PASSWORD=%s\n' "$(env_quote 'p@ss word$x')" >"$KH_HOME/special.env"
assert_eq "env_quote 包裹的密码读回原样" 'p@ss word$x' "$(env_get "$KH_HOME/special.env" KH_ADMIN_PASSWORD)"

finish
