#!/usr/bin/env bash
# 冒烟：假 docker 桩 + 临时目录 + 预设答案跑完整向导与管理命令，断言产物与行为。
# 全部经 kh_run 在独立进程里执行（交互输入沿 stdin 喂给 fd 9）
# shellcheck disable=SC2034,SC2016  # TEST_NAME 等供被测脚本与 finish 读取；kh_run 的 body 为单引号有意不在本进程展开
set -u
TEST_NAME="smoke"
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. "$(dirname "$0")/lib.sh"

# 顶层也要 source：断言里直接用 env_get / sha256_file 读产物
KH_SOURCE_ONLY=1
KH_TTY=-
NO_COLOR=1
# shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
. "$KH_TEST_SCRIPT"

BIN=$(stub_bin docker hostname curl ss)
PATH=$(path_with "$BIN")
export PATH

# kh_run 子进程与直接执行的脚本都从环境继承这套注入
ROOT="$(temp_dir)"
ETC="$ROOT/etc"
PROC="$ROOT/proc"
LOG="$ROOT/calls.log"
mkdir -p "$ETC" "$PROC"
printf 'Asia/Shanghai\n' >"$ETC/timezone"
: >"$PROC/net/tcp"
: >"$LOG"
export STUB_LOG="$LOG"
export KH_ETC="$ETC" KH_PROC="$PROC"
export KH_READY_TIMEOUT=2
export KH_SUDO=/nonexistent/sudo
export KH_SKIP_PLATFORM_CHECK=1
export STUB_IPS="192.168.1.20"

HOME_DIR="$ROOT/install"
BASENAME=$(basename "$HOME_DIR")
# 管理命令的进程彼此独立：每个 body 都要重新指认安装目录
WITH_HOME="KH_HOME=$HOME_DIR;"

# --- 1. 全新安装向导：目录 → Hub 镜像 → 端口(默认) → 监听 → 密码(随机) → 时区(默认) → 身份 → 对外地址 → 汇总确认 → 暂不启动 ---
r=$(printf '%s\n' "$HOME_DIR" 1 '' 1 '' '' 1 '' 1 n | kh_run 'cmd_install >/dev/null 2>&1; printf "rc=%s" "$?"')
assert_eq "向导全流程成功" "rc=0" "$r"
for p in kanban-hub.sh docker-compose.yml .env data backups .kanban-hub-state; do
  assert_cond "安装产物齐全：$p" test -e "$HOME_DIR/$p"
done
mode=$(stat -c '%a' "$HOME_DIR/kanban-hub.sh" 2>/dev/null || stat -f '%Lp' "$HOME_DIR/kanban-hub.sh")
assert_eq "脚本本体可执行（755）" "755" "$mode"
mode=$(stat -c '%a' "$HOME_DIR/.env" 2>/dev/null || stat -f '%Lp' "$HOME_DIR/.env")
assert_eq ".env 权限 600" "600" "$mode"
ENVP="$HOME_DIR/.env"
assert_eq "向导默认端口落盘" "28970" "$(env_get "$ENVP" KH_PORT)"
assert_eq "向导默认监听落盘" "0.0.0.0" "$(env_get "$ENVP" KH_BIND)"
assert_eq "随机密码长度 20" "20" "$(env_get "$ENVP" KH_ADMIN_PASSWORD | tr -d '\n' | wc -c | tr -d ' ')"
assert_eq "随机密码只含字母数字" "0" "$(env_get "$ENVP" KH_ADMIN_PASSWORD | tr -d 'A-Za-z0-9' | tr -d '\n' | wc -c | tr -d ' ')"
assert_eq "时区取自探测" "Asia/Shanghai" "$(env_get "$ENVP" TZ)"
assert_eq "对外地址按局域网 IP 推断" "http://192.168.1.20:28970" "$(env_get "$ENVP" KH_PUBLIC_URL)"
assert_eq "运行身份默认当前用户" "$(id -u):$(id -g)" "$(env_get "$ENVP" PUID):$(env_get "$ENVP" PGID)"
assert_eq "镜像名留空（Hub 默认）" "" "$(env_get "$ENVP" KH_IMAGE)"
assert_eq "镜像版本为脚本版本" "$KH_SCRIPT_VERSION" "$(env_get "$ENVP" KH_VERSION)"
ST="$HOME_DIR/.kanban-hub-state"
assert_eq "state 记录镜像来源" "hub" "$(env_get "$ST" image_source)"
assert_cond "state 记录安装时间" test -n "$(env_get "$ST" installed_at)"
assert_eq "state 校验和与 compose 文件一致" \
  "$(sha256_file "$HOME_DIR/docker-compose.yml")" "$(env_get "$ST" compose_sha256)"

# --- 1b. 汇总页选取消：安装目录可以已被创建，但不得残留任何文件 ---
CANCEL_DIR="$ROOT/cancelled"
r=$(printf '%s\n' "$CANCEL_DIR" 1 '' 1 '' '' 1 '' 9 | kh_run 'cmd_install >/dev/null 2>&1; printf "rc=%s" "$?"')
assert_eq "汇总页取消则安装失败收场" "rc=1" "$r"
for p in kanban-hub.sh docker-compose.yml .env data backups .kanban-hub-state; do
  assert_no_cond "取消安装不落任何文件：$p" test -e "$CANCEL_DIR/$p"
done

# --- 2. start：preflight → up -d → 轮询 /api/health ---
: >"$LOG"
r=$(kh_run "$WITH_HOME cmd_start >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "start 成功" "rc=0" "$r"
assert_contains "start 执行了 compose up -d" "docker compose up -d" "$(cat "$LOG")"

# --- 3. status 输出四要素 ---
r=$(kh_run "$WITH_HOME cmd_status 2>&1")
assert_contains "status 显示容器状态" "容器：" "$r"
assert_contains "status 显示镜像" "镜像：" "$r"
assert_contains "status 显示监听" "监听：" "$r"
assert_contains "status 显示数据目录磁盘" "所在磁盘剩余" "$r"
assert_not_contains "status 没有命令报错（防止未定义函数之类静默劣化）" "command not found" "$r"

# --- 3b. stop 与 logs ---
: >"$LOG"
r=$(kh_run "$WITH_HOME cmd_stop >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "stop 成功" "rc=0" "$r"
assert_contains "stop 执行了 compose stop" "docker compose stop" "$(cat "$LOG")"
: >"$LOG"
r=$(kh_run "$WITH_HOME cmd_logs >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "logs 成功" "rc=0" "$r"
assert_contains "logs 跟随 compose logs（最近 200 行）" "docker compose logs --tail 200" "$(cat "$LOG")"

# --- 3c. start 会补建缺失的数据目录 ---
rm -rf "$HOME_DIR/data" "$HOME_DIR/backups"
r=$(kh_run "$WITH_HOME cmd_start 2>&1; printf 'rc=%s' \"\$?\"")
assert_contains "start 补建缺失的 data/ 与 backups/" "已创建" "$r"
assert_eq "补建目录后 start 成功" "rc=0" "$(printf '%s\n' "$r" | tail -n 1)"
assert_cond "data/ 已重建" test -d "$HOME_DIR/data"
assert_cond "backups/ 已重建" test -d "$HOME_DIR/backups"

# --- 3d. 无交互终端时提示先下载再运行（不经 kh_run：它固定让 fd 9 沿用 stdin）---
r=$(printf '' | env KH_TTY=/nonexistent/tty bash -c '
  KH_SOURCE_ONLY=1
  NO_COLOR=1
  export KH_SOURCE_ONLY NO_COLOR
  exec 9<&- 2>/dev/null || true
  # shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
  . "$KH_TEST_SCRIPT"
  cmd_install >/dev/null 2>&1; printf "rc=%s" "$?"
')
assert_eq "无 TTY 时 cmd_install 失败" "rc=1" "$r"
r=$(printf '' | env KH_TTY=/nonexistent/tty bash -c '
  KH_SOURCE_ONLY=1
  NO_COLOR=1
  export KH_SOURCE_ONLY NO_COLOR
  exec 9<&- 2>/dev/null || true
  # shellcheck disable=SC1090  # 被测脚本路径经 lib.sh 注入
  . "$KH_TEST_SCRIPT"
  cmd_install 2>&1 | head -n 1
')
assert_contains "无 TTY 时提示先下载再执行" "先下载再执行" "$r"

# --- 4. config 改端口 ---
: >"$LOG"
r=$(printf '1\n31000\n6\nn\n' | kh_run "$WITH_HOME docker_probe >/dev/null 2>&1; cmd_config >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "config 成功" "rc=0" "$r"
assert_eq "config 改端口落盘" "31000" "$(env_get "$ENVP" KH_PORT)"
assert_not_contains "选择稍后生效时不重建容器" "compose up -d" "$(cat "$LOG")"

: >"$LOG"
r=$(printf '1\n31000\n6\ny\n' | kh_run "$WITH_HOME docker_probe >/dev/null 2>&1; cmd_config >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_contains "选择立即生效时重建容器" "compose up -d --force-recreate" "$(cat "$LOG")"

# --- 5. doctor：完好安装全部通过 ---
r=$(kh_run "$WITH_HOME cmd_doctor >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "doctor 对完好安装通过" "rc=0" "$r"

# --- 6. 已安装目录再次运行脚本 → 管理菜单（固定数字菜单与管道 stdin，任何环境行为一致）---
r=$(printf '\n10\n' | env KH_TTY=- KH_PLAIN=1 NO_COLOR=1 bash "$KH_TEST_SCRIPT" --dir "$HOME_DIR" install 2>&1)
assert_contains "已安装目录直接进入管理菜单" "部署管理" "$r"
assert_contains "管理菜单列出退出项" "退出" "$r"
assert_contains "管理菜单列出升级项" "升级" "$r"
assert_contains "管理菜单列出恢复项" "从备份恢复" "$r"

# --- 7. doctor：.env 缺必填项要报错 ---
grep -v '^KH_ADMIN_PASSWORD=' "$ENVP" >"$ROOT/env.bak" && mv "$ROOT/env.bak" "$ENVP"
r=$(kh_run "$WITH_HOME cmd_doctor 2>&1; printf 'rc=%s' \"\$?\"")
assert_contains "doctor 发现缺少管理员密码" "缺少必填项 KH_ADMIN_PASSWORD" "$r"
assert_contains "doctor 给出补齐建议" "config 补齐" "$r"
assert_eq "doctor 缺项时退出码 1" "rc=1" "$(printf '%s\n' "$r" | tail -n 1)"
printf 'KH_ADMIN_PASSWORD=secret-pass-1\n' >>"$ENVP"

# --- 8. doctor：compose 被手改提示 warn（不算失败）---
printf '# manual edit\n' >>"$HOME_DIR/docker-compose.yml"
r=$(kh_run "$WITH_HOME cmd_doctor 2>&1; printf 'rc=%s' \"\$?\"")
assert_contains "doctor 发现 compose 被手改" "被手动修改过" "$r"
assert_eq "手改仅为提醒不算失败" "rc=0" "$(printf '%s\n' "$r" | tail -n 1)"

# --- 9. uninstall 确认流 ---
: >"$LOG"
r=$(printf 'n\n' | kh_run "$WITH_HOME cmd_uninstall >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "uninstall 首步拒绝则整体取消" "rc=1" "$r"
assert_cond "拒绝后安装目录保留" test -d "$HOME_DIR"

r=$(printf 'y\nn\n' | kh_run "$WITH_HOME cmd_uninstall >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "uninstall 删容器但保留目录" "rc=0" "$r"
assert_contains "uninstall 执行了 compose down" "docker compose down" "$(cat "$LOG")"
assert_cond "保留模式下安装目录仍在" test -d "$HOME_DIR"

r=$(printf 'y\ny\nwrong-name\n' | kh_run "$WITH_HOME cmd_uninstall >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "输入目录名不符则放弃删除" "rc=0" "$r"
assert_cond "放弃删除后安装目录仍在" test -d "$HOME_DIR"

r=$(printf 'y\ny\n%s\n' "$BASENAME" | kh_run "$WITH_HOME cmd_uninstall >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "输入目录名相符则删除" "rc=0" "$r"
assert_no_cond "删除后安装目录消失" test -d "$HOME_DIR"

# --- 10. safe_remove_home 的黑名单与 state 校验 ---
mkdir -p "$ROOT/fake"
r=$(kh_run "KH_HOME=$ROOT/fake; safe_remove_home >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "无 state 文件的目录拒绝删除" "rc=1" "$r"
assert_cond "误报目标未被删除" test -d "$ROOT/fake"
r=$(kh_run 'KH_HOME=/opt; safe_remove_home >/dev/null 2>&1; printf "rc=%s" "$?"')
assert_eq "危险路径拒绝删除" "rc=1" "$r"

# --- 11. 入口：help / version / 未知命令 / 未安装提示 ---
r=$(bash "$KH_TEST_SCRIPT" version)
assert_eq "version 输出脚本版本" "$KH_SCRIPT_VERSION" "$(printf '%s' "$r" | tr -d '\n')"
r=$(bash "$KH_TEST_SCRIPT" help 2>&1)
assert_contains "help 输出用法" "用法：" "$r"
assert_contains "help 列出 upgrade" "  upgrade" "$r"
assert_contains "help 列出 restore" "  restore" "$r"
assert_contains "help 说明 --to 选项" "--to" "$r"
assert_contains "help 说明 --repo 选项" "--repo" "$r"
bash "$KH_TEST_SCRIPT" --bogus >/dev/null 2>&1
assert_rc "未知选项退出码 2" 2 "$?"
r=$(bash "$KH_TEST_SCRIPT" status 2>&1)
assert_contains "未安装时提示先安装" "尚未安装" "$r"
bash "$KH_TEST_SCRIPT" bogus >/dev/null 2>&1
assert_rc "未知命令退出码 2" 2 "$?"
r=$(bash "$KH_TEST_SCRIPT" upgrade 2>&1)
assert_contains "未安装时 upgrade 同样提示先安装" "尚未安装" "$r"
r=$(bash "$KH_TEST_SCRIPT" restore x.zip 2>&1)
assert_contains "未安装时 restore 同样提示先安装" "尚未安装" "$r"

# --- 12. restore：改名 / 新建 / compose run 参数 / 失败提示（假 docker 桩）---
KH2="$ROOT/restored"
WITH2="KH_HOME=$KH2;"
r=$(kh_run "KH_HOME=$KH2; wizard_defaults; W_PASSWORD=secret-pass-1; W_TZ=Asia/Shanghai; apply_install >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "restore 用例的安装目录就绪" "rc=0" "$r"
cp "$KH_TEST_SCRIPT" "$KH2/kanban-hub.sh"
printf 'old-board-data\n' >"$KH2/data/old.txt"
printf 'backup-payload\n' >"$KH2/backups/kanban-hub-20260929-120000.zip"

r=$(kh_run "$WITH2 cmd_restore sub/dir.zip >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "restore 拒绝路径参数" "rc=2" "$r"
r=$(kh_run "$WITH2 cmd_restore other.zip >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "restore 拒绝不符命名的文件名" "rc=2" "$r"
r=$(kh_run "$WITH2 cmd_restore kanban-hub-20260929-120001.zip 2>&1; printf 'rc=%s' \"\$?\"")
assert_contains "restore 提示备份不存在" "没有" "$r"
assert_cond "备份不存在时 data/ 未被改名" test -f "$KH2/data/old.txt"

: >"$LOG"
r=$(printf 'y\nn\n' | kh_run "$WITH2 cmd_restore kanban-hub-20260929-120000.zip >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "restore 成功" "rc=0" "$r"
assert_contains "restore 先停止容器" "docker compose stop" "$(cat "$LOG")"
assert_contains "restore 经容器执行恢复并指向 /backups" \
  "docker compose run --rm kanban-hub restore /backups/kanban-hub-20260929-120000.zip" "$(cat "$LOG")"
assert_cond "原数据改名保留（data.bak-时间戳）" test -f "$KH2"/data.bak-*/old.txt
assert_eq "新建的 data/ 为空" "" "$(ls -A "$KH2/data")"
assert_not_contains "询问启动回答否则不启动服务" "compose up" "$(cat "$LOG")"

printf 'later\n' >"$KH2/data/new.txt"
: >"$LOG"
r=$(printf 'y\n' | PATH=$(path_with "$BIN") STUB_RUN_EXIT=1 kh_run "$WITH2 cmd_restore kanban-hub-20260929-120000.zip 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "恢复失败返回 1" "rc=1" "$(printf '%s\n' "$r" | tail -n 1)"
assert_contains "失败提示原数据保留位置" "data.bak-" "$r"
assert_contains "失败提示可改回原名回退" "改名" "$r"
n=$(count_entries "$KH2" "data.bak-")
assert_eq "失败后原数据目录仍在（两次各留一份）" "2" "$n"

# 停止容器失败：在改名之前中止，不再产生新的备份目录
r=$(printf 'y\n' | PATH=$(path_with "$BIN") STUB_COMPOSE_EXIT=1 kh_run "$WITH2 cmd_restore kanban-hub-20260929-120000.zip >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "停止容器失败则中止恢复" "rc=1" "$r"
assert_eq "中止在改名之前（备份目录数量不变）" "2" "$(count_entries "$KH2" "data.bak-")"

# --- 13. upgrade：自更新两阶段 exec → 版本落盘 → pull → 重建 ---
KH3="$ROOT/upgraded"
r=$(kh_run "KH_HOME=$KH3; wizard_defaults; W_PASSWORD=secret-pass-1; W_TZ=Asia/Shanghai; apply_install >/dev/null 2>&1; printf 'rc=%s' \"\$?\"")
assert_eq "upgrade 用例的安装目录就绪" "rc=0" "$r"
cp "$KH_TEST_SCRIPT" "$KH3/kanban-hub.sh"
NEW3="$ROOT/kh-new.sh"
sed "s/^KH_SCRIPT_VERSION=.*/KH_SCRIPT_VERSION=\"0.2.0\"/" "$KH_TEST_SCRIPT" >"$NEW3"
: >"$LOG"
r=$(printf 'y\n' | PATH=$(path_with "$BIN") STUB_CURL_FILE="$NEW3" kh_run "KH_HOME=$KH3; unset KH_SOURCE_ONLY; OPT_TO=0.2.0; cmd_upgrade >/dev/null 2>&1")
assert_rc "upgrade 两阶段完成（旧脚本 exec 新脚本续跑）" 0 "$?"
assert_eq ".env 版本已更新到目标版本" "0.2.0" "$(env_get "$KH3/.env" KH_VERSION)"
assert_contains "替换后安装目录里的脚本是新版本" 'KH_SCRIPT_VERSION="0.2.0"' "$(cat "$KH3/kanban-hub.sh")"
assert_eq "自更新前的旧脚本备份了一份" "1" "$(count_entries "$KH3/backups" "kanban-hub.sh.")"
assert_contains "旧脚本备份内容是原版本" "KH_SCRIPT_VERSION=\"$KH_SCRIPT_VERSION\"" "$(cat "$KH3"/backups/kanban-hub.sh.*)"
assert_contains "第二阶段拉取了镜像" "docker compose pull" "$(cat "$LOG")"
assert_contains "第二阶段重建容器" "docker compose up -d --force-recreate" "$(cat "$LOG")"

finish
