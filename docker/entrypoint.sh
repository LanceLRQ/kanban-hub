#!/bin/sh
# kanban-hub 容器入口：统一设置权限掩码、HOME 与 git 身份，再按子命令启动。
set -eu

umask "${UMASK:-022}"

# 容器以 PUID 运行，这个 UID 在镜像里可能没有对应的用户，也就没有可用的 HOME。
# git 需要 HOME 读写配置，这里统一指到一个可写目录。
export HOME=/tmp/kh-home
mkdir -p "$HOME"

# 服务端提交数据仓库时的 committer；author 由程序按操作者逐次指定。
export GIT_COMMITTER_NAME=kanban-hub
export GIT_COMMITTER_EMAIL=kanban-hub@localhost

cmd="${1:-serve}"
case "$cmd" in
  serve)
    exec node /app/apps/web/server.js
    ;;
  *)
    echo "未知子命令：$cmd（可用：serve）" >&2
    exit 2
    ;;
esac
