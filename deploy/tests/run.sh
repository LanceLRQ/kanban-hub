#!/usr/bin/env bash
# 部署脚本测试入口：语法检查 → 全部单测 → 冒烟 → shellcheck（缺失时打印跳过警告）。
# 用法：bash deploy/tests/run.sh（或 pnpm test:deploy）
set -u
cd "$(dirname "$0")/.." || exit 1

failed=0

echo "== bash -n kanban-hub.sh（语法）=="
if bash -n kanban-hub.sh; then
  echo "  ok"
else
  failed=1
fi

for t in tests/test-*.sh; do
  echo "== $t =="
  if ! bash "$t"; then
    failed=1
  fi
done

echo "== tests/smoke.sh =="
if ! bash tests/smoke.sh; then
  failed=1
fi

if command -v shellcheck >/dev/null 2>&1; then
  echo "== shellcheck =="
  if ! shellcheck kanban-hub.sh tests/*.sh; then
    failed=1
  fi
else
  echo "!! 未找到 shellcheck，跳过静态检查（本机安装后重跑：brew install shellcheck / apt install shellcheck）" >&2
fi

if [ "$failed" = 0 ]; then
  echo "deploy tests: 全部通过"
else
  echo "deploy tests: 存在失败项"
fi
exit "$failed"
