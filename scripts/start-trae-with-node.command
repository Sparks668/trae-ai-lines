#!/bin/bash

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

find_node() {
  local node_bin candidate
  node_bin=$(command -v node)
  if [[ -x "$node_bin" ]]; then
    printf '%s\n' "$node_bin"
    return
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1
    if node_bin=$(nvm which default 2>/dev/null) && [[ -x "$node_bin" ]]; then
      printf '%s\n' "$node_bin"
      return
    fi
  fi

  for candidate in "$NVM_DIR"/versions/node/v*/bin/node; do
    [[ -x "$candidate" ]] && printf '%s\n' "$candidate"
  done | /usr/bin/sort -V | /usr/bin/tail -n 1
}

find_app() {
  local dir name
  for name in 'Trae CN' 'TRAE SOLO CN' 'Trae'; do
    for dir in /Applications "$HOME/Applications"; do
      if [[ -d "$dir/$name.app" ]]; then
        printf '%s\n' "$dir/$name.app"
        return
      fi
    done
  done
}

app=${1:-$(find_app)}
[[ -n "$app" && -d "$app" ]] || fail '找不到 Trae。请把 Trae 安装到「应用程序」后再双击此脚本。'
app=$(cd "$app" && pwd -P) || fail '无法打开 Trae 应用目录。'
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)
[[ -n "$executable" && -x "$app/Contents/MacOS/$executable" ]] || fail 'Trae 应用无法启动，请确认选择了正确的 .app。'

if /bin/ps -axo comm= | /usr/bin/grep -Fxq "$app/Contents/MacOS/$executable"; then
  fail "${app##*/} 正在运行。请先按 ⌘Q 完全退出，再双击此脚本。"
fi

node_bin=$(find_node)
[[ -x "$node_bin" ]] || fail '未找到可执行的 Node.js，请让同事确认终端能运行 node -v。'
node_version=$("$node_bin" --version) || fail "无法运行 Node.js（$node_bin）。"

/usr/bin/open --env "PATH=${node_bin%/*}:$PATH" -a "$app" || fail '启动 Trae 失败，请查看上方错误。'
printf '已启动 %s，Git 可使用 Node.js %s（%s）。\n' "${app##*/}" "$node_version" "$node_bin"
