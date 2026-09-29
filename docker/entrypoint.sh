#!/bin/sh
# kanban-hub 容器入口：统一设置权限掩码与 HOME，再按子命令启动。
set -eu

umask "${UMASK:-022}"

# 容器以 PUID 运行，这个 UID 在镜像里可能没有对应的用户，也就没有可用的 HOME。
# git 需要 HOME 读写配置，这里统一指到一个可写目录。
export HOME=/tmp/kh-home
mkdir -p "$HOME"

cmd="${1:-serve}"
case "$cmd" in
  serve)
    exec node /app/apps/web/server.js
    ;;
  restore)
    # 去掉子命令本身，剩下的参数都交给恢复入口
    shift
    exec node /app/restore.mjs "$@"
    ;;
  *)
    echo "未知子命令：$cmd（可用：serve、restore）" >&2
    exit 2
    ;;
esac
