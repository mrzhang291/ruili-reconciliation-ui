#!/bin/sh

cd "$(dirname "$0")" || exit 1

node_path=$(command -v node 2>/dev/null || true)
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -z "$node_path" ] && [ -x "$candidate" ]; then
    node_path=$candidate
  fi
done

if [ -z "$node_path" ]; then
  echo "请先安装 Node.js 22.13 或更高版本。"
  printf "按回车键关闭…"
  read -r _
  exit 1
fi

PATH="$(dirname "$node_path"):$PATH" "$node_path" scripts/start-all.mjs "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo
  echo "启动失败，日志目录：$PWD/.runtime/logs"
  printf "按回车键关闭…"
  read -r _
fi
exit "$status"
