#!/usr/bin/env bash
# ============================================================================
# release.sh —— Trae AI Lines 一键发布到 Open VSX
#
# 用法:
#   ./scripts/release.sh patch          # 0.2.41 -> 0.2.42 并发布(最常用)
#   ./scripts/release.sh minor          # 0.2.41 -> 0.3.0 并发布
#   ./scripts/release.sh 0.3.0          # 指定版本号并发布
#   ./scripts/release.sh                # 不改版本号,重新发布当前版本
#
# 前置条件(只需一次):
#   1. 在 https://open-vsx.org 注册账号并创建 publisher(名字须为 package.json 的 publisher, 当前是 bobchen)
#   2. 生成 Access Token, 写入本机文件:  echo "你的Token" > ~/.ovsx-token
#   3. 首次发布执行:  ./scripts/release.sh --init   (创建 bobchen 命名空间)
#
# 发布成功后,Trae 已安装用户会在数小时内自动收到更新。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PAT="${OVSX_PAT:-}"
if [ -z "$PAT" ] && [ -f "$HOME/.ovsx-token" ]; then
  PAT="$(cat "$HOME/.ovsx-token" | tr -d '[:space:]')"
fi
if [ -z "$PAT" ]; then
  echo "错误: 未找到 Open VSX Token。请先执行:  echo '你的Token' > ~/.ovsx-token"
  exit 1
fi

PUBLISHER="$(node -p "require('./package.json').publisher")"
CUR_VER="$(node -p "require('./package.json').version")"

# --init: 仅创建命名空间(首次发布前执行一次)
if [ "${1:-}" = "--init" ]; then
  echo "==> 创建 Open VSX 命名空间: $PUBLISHER"
  npx --yes ovsx create-namespace "$PUBLISHER" -p "$PAT"
  echo "==> 完成。之后即可正常发版: ./scripts/release.sh patch"
  exit 0
fi

# 版本号处理: patch/minor/major 走 npm version, 具体版本号直接写入, 空则保持当前版本
BUMP="${1:-}"
case "$BUMP" in
  patch|minor|major)
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ;;
  "")
    ;;
  *)
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ;;
esac
NEW_VER="$(node -p "require('./package.json').version")"
echo "==> 版本: $CUR_VER -> $NEW_VER"

# 打包
echo "==> 打包 vsix ..."
npx --yes @vscode/vsce package --allow-missing-repository
VSIX="trae-ai-lines-$NEW_VER.vsix"
[ -f "$VSIX" ] || { echo "错误: 未找到打包产物 $VSIX"; exit 1; }

# 发布
echo "==> 发布到 Open VSX ..."
npx --yes ovsx publish "$VSIX" -p "$PAT"

echo ""
echo "✅ 发布成功: trae-ai-lines v$NEW_VER"
echo "   市场页: https://open-vsx.org/namespace/$PUBLISHER/trae-ai-lines"
echo "   Trae 用户将在数小时内自动收到更新;新用户可直接在扩展面板搜索安装。"
