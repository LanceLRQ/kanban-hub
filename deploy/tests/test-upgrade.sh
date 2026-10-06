#!/usr/bin/env bash
# 单测：upgrade——版本判定与降级警告、自更新下载-校验-备份-替换序列、模板 sha 分支、
# pull 失败回滚、本地镜像菜单（重建 / 切回 Hub / 取消）
# shellcheck disable=SC2034,SC2016  # TEST_NAME 等供被测脚本与 finish 读取；kh_run 的 body 为单引号有意不在本进程展开
set -u
TEST_NAME="test-upgrade"
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. "$(dirname "$0")/lib.sh"

KH_SOURCE_ONLY=1
KH_TTY=-
NO_COLOR=1
KH_PLAIN=1
# shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
. "$KH_TEST_SCRIPT"

BIN=$(stub_bin docker curl hostname ss)
LOG="$(temp_dir)/calls.log"
: >"$LOG"
export STUB_LOG="$LOG"
export KH_READY_TIMEOUT=2

# 已安装目录：.env（版本可指定）+ state + compose + data/backups + 脚本本体
make_install() {
  local d v="${1:-$KH_SCRIPT_VERSION}"
  d=$(temp_dir)
  mkdir -p "$d/data" "$d/backups"
  {
    printf 'KH_ADMIN_PASSWORD=secret-pass-1\n'
    printf 'KH_VERSION=%s\n' "$v"
    printf 'KH_IMAGE=\n'
    printf 'PUID=%s\n' "$(id -u)"
    printf 'PGID=%s\n' "$(id -g)"
    printf 'KH_PORT=28970\n'
    printf 'KH_BIND=0.0.0.0\n'
    printf 'KH_PUBLIC_URL=\n'
  } >"$d/.env"
  tpl_compose >"$d/docker-compose.yml"
  {
    printf 'compose_sha256=%s\n' "$(sha256_file "$d/docker-compose.yml")"
    printf 'template_version=%s\n' "$KH_TEMPLATE_VERSION"
    printf 'image_source=hub\n'
  } >"$d/.kanban-hub-state"
  cp "$KH_TEST_SCRIPT" "$d/kanban-hub.sh"
  printf '%s' "$d"
}

# 生成"远端新脚本"作为下载源：只改版本行（curl 桩经 STUB_CURL_FILE 原样复制）
make_remote_script() {
  sed "s/^KH_SCRIPT_VERSION=.*/KH_SCRIPT_VERSION=\"$2\"/" "$KH_TEST_SCRIPT" >"$1"
}

backup_count() { count_entries "$1/backups" "kanban-hub.sh."; }

# --- 版本行是跨版本接口：自更新按这一整行精确匹配，格式与唯一性必须锁住 ---
assert_eq "版本行以精确格式存在且唯一" "1" \
  "$(grep -cxF "KH_SCRIPT_VERSION=\"$KH_SCRIPT_VERSION\"" "$KH_TEST_SCRIPT")"

# --- parse_args 识别 --to / --repo ---
r=$(kh_run 'parse_args upgrade --to 0.2.0; printf "%s|%s" "$CMD" "$OPT_TO"')
assert_eq "parse_args 识别 --to" "upgrade|0.2.0" "$r"
r=$(kh_run 'parse_args upgrade --to=0.3.0 --repo=/tmp/repo; printf "%s|%s" "$OPT_TO" "$OPT_REPO"')
assert_eq "parse_args 识别 = 形式" "0.3.0|/tmp/repo" "$r"

# --- _upgrade_apply：目标等于当前版本（镜像已在本地：无事可做）---
D=$(make_install)
: >"$LOG"
r=$(printf '' | PATH=$(path_with "$BIN") STUB_IMAGE_EXISTS=1 kh_run "KH_HOME=$D; OPT_TO=$KH_SCRIPT_VERSION; _upgrade_apply >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_eq "目标等于当前版本：applied 不动镜像" "rc=0|applied" "$r"
assert_not_contains "版本未变时不执行 compose pull" "compose pull" "$(cat "$LOG")"
assert_eq ".env 版本未变" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"

# --- _upgrade_apply：版本号已落盘但镜像未拉取（上次升级半途中断）→ 补 pull + 重建收敛 ---
D=$(make_install)
: >"$LOG"
r=$(printf '' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=$KH_SCRIPT_VERSION; _upgrade_apply 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_contains "版本已落盘但镜像缺失：applied 收敛" "rc=0|applied" "$r"
assert_contains "半途状态补拉取镜像" "compose pull" "$(cat "$LOG")"
assert_contains "半途状态补重建容器" "compose up -d --force-recreate" "$(cat "$LOG")"
assert_not_contains "收敛路径不误报无需升级" "无需升级" "$r"
assert_eq ".env 版本保持目标值" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"

# --- _upgrade_apply：--to 版本格式非法 ---
D=$(make_install)
for bad in abc 1.2 1.2.3.4; do
  r=$(printf '' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=$bad; _upgrade_apply >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
  assert_eq "非法版本 --to $bad 拒绝为用法错误" "rc=2" "$r"
done
r=$(printf '' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=abc; _upgrade_apply 2>&1 >/dev/null; printf 'rc=%s' \"\$?\"")
assert_contains "非法版本给出格式提示" "版本格式" "$r"
assert_eq "非法版本不动 .env" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"
r=$(printf '' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=1.2.3-rc.1; parse_args upgrade --to \"\$OPT_TO\"; valid_version \"\$OPT_TO\"; printf 'rc=%s' \"\$?\"")
assert_eq "合法预发布版本通过校验" "rc=0" "$r"

# --- _upgrade_apply：降级警告与拒绝 ---（目标版本必须低于 KH_SCRIPT_VERSION，当前 0.1.2）
D=$(make_install)
r=$(printf 'n\n' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=0.0.1; _upgrade_apply 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_contains "降级被拒绝则 declined 且不算失败" "rc=0|declined" "$r"
assert_contains "降级时给出警告" "降级" "$r"
assert_eq "拒绝后 .env 版本未动" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"

# --- _upgrade_apply：自更新失败且拒绝"仅更新镜像" ---
D=$(make_install)
: >"$LOG"
r=$(printf 'y\nn\n' | PATH=$(path_with "$BIN") STUB_CURL_EXIT=7 kh_run "KH_HOME=$D; OPT_TO=0.2.0; _upgrade_apply 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_contains "自更新失败且拒绝仅更新镜像：rolled_back" "rc=1|rolled_back" "$r"
assert_contains "自更新失败给出原因" "下载" "$r"
assert_eq "自更新失败时 .env 版本未动" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"
assert_not_contains "整体未确认时不执行 compose pull" "compose pull" "$(cat "$LOG")"

# --- _upgrade_apply：pull 失败回滚版本号（目标=脚本版本，不触发自更新）---
D=$(make_install 0.9.0)
: >"$LOG"
r=$(printf '' | PATH=$(path_with "$BIN") STUB_PULL_EXIT=1 KH_UPGRADE_CONFIRMED=1 kh_run "KH_HOME=$D; OPT_TO=$KH_SCRIPT_VERSION; _upgrade_apply >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_eq "pull 失败：rolled_back" "rc=1|rolled_back" "$r"
assert_eq "pull 失败回退 .env 版本号" "0.9.0" "$(env_get "$D/.env" KH_VERSION)"
assert_contains "回滚前执行过 compose pull" "compose pull" "$(cat "$LOG")"

# --- _upgrade_apply：pull 成功则重建容器并 applied ---
D=$(make_install 0.9.0)
: >"$LOG"
r=$(printf '' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=$KH_SCRIPT_VERSION; KH_UPGRADE_CONFIRMED=1; _upgrade_apply >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_eq "pull 成功并重建容器：applied" "rc=0|applied" "$r"
assert_eq ".env 版本已更新" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"
assert_contains "重建容器用 force-recreate" "compose up -d --force-recreate" "$(cat "$LOG")"

# --- cmd_upgrade：本地镜像菜单（OPT_REPO 不指向仓库 → 只有 切回/取消 两项）---
NOREPO="$(temp_dir)/norepo"
mkdir -p "$NOREPO"
D=$(make_install dev)
env_set "$D/.env" KH_IMAGE kanban-hub
env_set "$D/.kanban-hub-state" image_source build
: >"$LOG"
r=$(printf '2\n' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=$KH_SCRIPT_VERSION; OPT_REPO=$NOREPO; cmd_upgrade >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_eq "本地镜像菜单取消则不做事" "rc=0|" "$r"
assert_not_contains "取消时不执行 compose pull" "compose pull" "$(cat "$LOG")"
assert_eq "取消后镜像名不变" "kanban-hub" "$(env_get "$D/.env" KH_IMAGE)"

D=$(make_install dev)
env_set "$D/.env" KH_IMAGE kanban-hub
env_set "$D/.kanban-hub-state" image_source build
: >"$LOG"
r=$(printf '1\ny\n' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_TO=$KH_SCRIPT_VERSION; OPT_REPO=$NOREPO; cmd_upgrade >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$UPGRADE_OUTCOME\"")
assert_eq "本地镜像切回 Hub：applied" "rc=0|applied" "$r"
assert_eq "镜像名清空（回到模板默认 Hub）" "" "$(env_get "$D/.env" KH_IMAGE)"
assert_eq "版本已更新" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"
assert_eq "state 镜像来源记回 hub" "hub" "$(env_get "$D/.kanban-hub-state" image_source)"
assert_contains "切回后拉取并重建" "compose pull" "$(cat "$LOG")"

# --- cmd_upgrade：本地镜像从仓库重新构建（--repo 指定仓库）---
REPO="$(temp_dir)/repo"
mkdir -p "$REPO"
printf 'FROM scratch\n' >"$REPO/Dockerfile"
printf '{"name":"kanban-hub"}\n' >"$REPO/package.json"
D=$(make_install dev)
env_set "$D/.env" KH_IMAGE kanban-hub
env_set "$D/.kanban-hub-state" image_source build
: >"$LOG"
r=$(printf '1\n' | PATH=$(path_with "$BIN") STUB_IMAGE_EXISTS=1 kh_run "KH_HOME=$D; OPT_REPO=$REPO; cmd_upgrade >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "从仓库重新构建成功" "rc=0" "$r"
assert_contains "执行了 docker build" "docker build" "$(cat "$LOG")"
assert_contains "构建后重建容器" "compose up -d --force-recreate" "$(cat "$LOG")"
assert_eq "镜像名保持本地构建名" "kanban-hub" "$(env_get "$D/.env" KH_IMAGE)"
assert_eq "镜像版本记为 dev" "dev" "$(env_get "$D/.env" KH_VERSION)"
assert_eq "state 镜像来源记 build" "build" "$(env_get "$D/.kanban-hub-state" image_source)"

# 构建失败：不动 .env、不重建容器
D=$(make_install)
env_set "$D/.env" KH_IMAGE kanban-hub
env_set "$D/.kanban-hub-state" image_source build
: >"$LOG"
r=$(printf '1\n' | PATH=$(path_with "$BIN") STUB_BUILD_EXIT=1 kh_run "KH_HOME=$D; OPT_REPO=$REPO; cmd_upgrade >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "构建失败返回 1" "rc=1" "$r"
assert_not_contains "构建失败不重建容器" "compose up" "$(cat "$LOG")"
assert_eq "构建失败 .env 版本未动" "$KH_SCRIPT_VERSION" "$(env_get "$D/.env" KH_VERSION)"

# env_set 半途失败（版本行值非法）：回滚已写入的镜像名，不留半新 .env
D=$(make_install)
env_set "$D/.env" KH_IMAGE my-image
env_set "$D/.env" KH_VERSION 9.9.9
: >"$LOG"
r=$(printf '' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_REPO=$REPO; KH_DEV_TAG=\"bad'x\"; cmd_upgrade_rebuild \"\$OPT_REPO\" >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "env 写入半途失败返回 1" "rc=1" "$r"
assert_eq "env 写入失败回滚镜像名" "my-image" "$(env_get "$D/.env" KH_IMAGE)"
assert_eq "env 写入失败版本号未动" "9.9.9" "$(env_get "$D/.env" KH_VERSION)"
assert_not_contains "写入失败不重建容器" "compose up" "$(cat "$LOG")"

# OPT_REPO 不是仓库：不出现重建项，菜单只有 切回/取消
D=$(make_install)
env_set "$D/.env" KH_IMAGE kanban-hub
r=$(printf '9\n' | PATH=$(path_with "$BIN") kh_run "KH_HOME=$D; OPT_REPO=$NOREPO; cmd_upgrade 2>&1; printf 'rc=%s' \"\$?\"")
assert_not_contains "非仓库目录不出现重建选项" "重新构建" "$r"

# --- self_update：下载-校验-备份-替换序列 ---
NEW="$(temp_dir)/new.sh"
make_remote_script "$NEW" 0.2.0
D=$(make_install)
: >"$LOG"
r=$(PATH=$(path_with "$BIN") STUB_CURL_FILE="$NEW" kh_run "KH_HOME=$D; self_update 0.2.0 >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "self_update 成功" "rc=0" "$r"
assert_contains "下载走 raw 的 v 标签地址" "v0.2.0/deploy/kanban-hub.sh" "$(cat "$LOG")"
assert_contains "替换后的脚本是目标版本" 'KH_SCRIPT_VERSION="0.2.0"' "$(cat "$D/kanban-hub.sh")"
assert_eq "旧脚本备份进 backups/ 一份" "1" "$(backup_count "$D")"
assert_contains "备份内容是旧版本" "KH_SCRIPT_VERSION=\"$KH_SCRIPT_VERSION\"" "$(cat "$D"/backups/kanban-hub.sh.*)"
assert_no_cond "临时文件已清理" test -e "$D/.kanban-hub.sh.upgrade"
mode=$(stat -c '%a' "$D/kanban-hub.sh" 2>/dev/null || stat -f '%Lp' "$D/kanban-hub.sh")
assert_eq "替换后脚本仍可执行" "755" "$mode"
bash -n "$D/kanban-hub.sh" 2>/dev/null
assert_rc "替换后的脚本语法有效" 0 "$?"

# 版本行不符：原脚本不动、原因 self_version_mismatch
BAD="$(temp_dir)/bad.sh"
make_remote_script "$BAD" 9.9.9
D=$(make_install)
r=$(PATH=$(path_with "$BIN") STUB_CURL_FILE="$BAD" kh_run "KH_HOME=$D; self_update 0.2.0 >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$SELF_UPDATE_REASON\"")
assert_eq "版本行不符则失败" "rc=1|self_version_mismatch" "$r"
assert_contains "版本不符时原脚本未被替换" "KH_SCRIPT_VERSION=\"$KH_SCRIPT_VERSION\"" "$(cat "$D/kanban-hub.sh")"
assert_eq "版本不符不产生备份" "0" "$(backup_count "$D")"

# 语法不过：原因 self_syntax_failed
D=$(make_install)
r=$(PATH=$(path_with "$BIN") STUB_CURL_BODY='then fi' kh_run "KH_HOME=$D; self_update 0.2.0 >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$SELF_UPDATE_REASON\"")
assert_eq "下载内容语法不过则失败" "rc=1|self_syntax_failed" "$r"
assert_contains "语法不过时原脚本未被替换" "KH_SCRIPT_VERSION=\"$KH_SCRIPT_VERSION\"" "$(cat "$D/kanban-hub.sh")"

# 下载失败：原因 self_download_failed，原脚本不动
D=$(make_install)
: >"$LOG"
r=$(PATH=$(path_with "$BIN") STUB_CURL_EXIT=7 kh_run "KH_HOME=$D; self_update 0.2.0 >/dev/null 2>&1; printf 'rc=%s|%s' \"\$?\" \"\$SELF_UPDATE_REASON\"")
assert_eq "下载失败则失败" "rc=1|self_download_failed" "$r"
assert_contains "下载失败时原脚本未被替换" "KH_SCRIPT_VERSION=\"$KH_SCRIPT_VERSION\"" "$(cat "$D/kanban-hub.sh")"
assert_eq "下载失败不产生备份" "0" "$(count_entries "$D/backups")"

# --- template_sync：模板版本没推进时不动已存在的文件 ---
D=$(make_install)
printf '# 手改内容\n' >>"$D/docker-compose.yml"
KH_HOME="$D" template_sync >/dev/null 2>&1
assert_rc "版本未推进时 template_sync 成功返回" 0 "$?"
assert_contains "版本未推进时保留已安装文件" "# 手改内容" "$(cat "$D/docker-compose.yml")"
assert_eq "版本未推进时不产生备份" "0" "$(count_entries "$D/backups")"

# --- template_sync：版本推进 + 未手改 → 静默替换 ---
D=$(make_install)
env_set "$D/.kanban-hub-state" template_version 0
KH_HOME="$D" template_sync >/dev/null 2>&1
assert_rc "未手改时静默替换成功" 0 "$?"
assert_eq "替换为新模板内容" "$(tpl_compose)" "$(cat "$D/docker-compose.yml")"
assert_eq "state 校验和已更新" "$(sha256_file "$D/docker-compose.yml")" "$(env_get "$D/.kanban-hub-state" compose_sha256)"
assert_eq "模板版本已推进" "$KH_TEMPLATE_VERSION" "$(env_get "$D/.kanban-hub-state" template_version)"
assert_eq "未手改不产生备份" "0" "$(count_entries "$D/backups")"

# --- template_sync：版本推进 + 内容已与新模板一致 → 只补记 state ---
D=$(make_install)
env_set "$D/.kanban-hub-state" template_version 0
KH_HOME="$D" template_sync >/dev/null 2>&1
assert_eq "内容一致时无备份产生" "0" "$(count_entries "$D/backups")"
assert_eq "内容一致时版本同样推进" "$KH_TEMPLATE_VERSION" "$(env_get "$D/.kanban-hub-state" template_version)"

# --- template_sync：版本推进 + 手改 → 弹 diff 询问 ---
D=$(make_install)
env_set "$D/.kanban-hub-state" template_version 0
printf '# 手改内容\n' >>"$D/docker-compose.yml"
r=$(printf 'n\n' | kh_run "KH_HOME=$D; template_sync >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "拒绝覆盖仍算成功（保留手改继续）" "rc=0" "$r"
assert_contains "拒绝后保留手改文件" "# 手改内容" "$(cat "$D/docker-compose.yml")"
assert_eq "拒绝后不产生备份" "0" "$(count_entries "$D/backups")"
assert_eq "拒绝后版本同样推进（不再反复询问）" "$KH_TEMPLATE_VERSION" "$(env_get "$D/.kanban-hub-state" template_version)"

# 同意覆盖：重置版本标记再跑一次（版本未推进时上面已验证会跳过）
env_set "$D/.kanban-hub-state" template_version 0
r=$(printf 'y\n' | kh_run "KH_HOME=$D; template_sync >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "同意覆盖成功" "rc=0" "$r"
assert_not_contains "同意后手改内容被替换" "# 手改内容" "$(cat "$D/docker-compose.yml")"
assert_eq "覆盖前备份了一份" "1" "$(count_entries "$D/backups" "docker-compose.yml.")"
assert_eq "覆盖后 state 校验和更新" "$(sha256_file "$D/docker-compose.yml")" "$(env_get "$D/.kanban-hub-state" compose_sha256)"

# 手改的 diff 展示给用户
D=$(make_install)
env_set "$D/.kanban-hub-state" template_version 0
printf '# 手改内容\n' >>"$D/docker-compose.yml"
r=$(printf 'n\n' | kh_run "KH_HOME=$D; template_sync 2>&1 >/dev/null")
assert_contains "手改时展示差异" "手动修改过" "$r"

# --- template_sync：文件缺失一律直接写入 ---
D=$(make_install)
rm -f "$D/docker-compose.yml"
KH_HOME="$D" template_sync >/dev/null 2>&1
assert_rc "文件缺失时直接写入成功" 0 "$?"
assert_eq "缺失文件补齐为新模板" "$(tpl_compose)" "$(cat "$D/docker-compose.yml")"

# --- template_sync_rollback：恢复备份文件与 state ---
D=$(make_install)
env_set "$D/.kanban-hub-state" template_version 0
printf '# 手改内容\n' >>"$D/docker-compose.yml"
OLD_SHA=$(env_get "$D/.kanban-hub-state" compose_sha256)
r=$(printf 'y\n' | kh_run "KH_HOME=$D; template_sync >/dev/null 2>&1; template_sync_rollback; printf 'rc=%s' \"\$?\"")
assert_eq "回滚执行成功" "rc=0" "$r"
assert_contains "回滚后文件恢复为替换前内容" "# 手改内容" "$(cat "$D/docker-compose.yml")"
assert_eq "回滚后 state 校验和复原" "$OLD_SHA" "$(env_get "$D/.kanban-hub-state" compose_sha256)"
assert_eq "回滚后模板版本复原" "0" "$(env_get "$D/.kanban-hub-state" template_version)"

finish
