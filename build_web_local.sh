#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENABLE_WSS="${ENABLE_WSS:-false}"
for arg in "$@"; do
  case $arg in
    --secure|--wss)
      ENABLE_WSS="true"
      shift
      ;;
  esac
done


echo "=== Step 1: Checking prerequisites ==="
check_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "Error: '$1' command not found. Please install it first." >&2
    exit 1
  fi
}
check_cmd git
check_cmd tar
check_cmd curl
check_cmd node
check_cmd yarn

if [[ ! -f "$SCRIPT_DIR/libs/hbb_common/protos/message.proto" ]]; then
  echo "=== Initializing git submodules ==="
  git submodule update --init --recursive
fi

FLUTTER_CMD="flutter"
if command -v fvm &> /dev/null; then
  FLUTTER_CMD="fvm flutter"
elif ! command -v flutter &> /dev/null; then
  echo "Error: 'flutter' command not found. Please install Flutter or FVM first." >&2
  exit 1
fi

echo "=== Step 2: Extracting web dependencies ==="
WEB_DEPS_TAR="${WEB_DEPS_TAR:-}"
if [[ -z "$WEB_DEPS_TAR" ]]; then
  if [[ -f "$SCRIPT_DIR/../docker-rustdesk-web-client/web_deps.tar.gz" ]]; then
    WEB_DEPS_TAR="$SCRIPT_DIR/../docker-rustdesk-web-client/web_deps.tar.gz"
  else
    WEB_DEPS_TAR="$SCRIPT_DIR/flutter/web/web_deps.tar.gz"
  fi
fi

if [[ ! -f "$WEB_DEPS_TAR" ]]; then
  echo "Downloading web_deps.tar.gz from GitHub..."
  curl -L -o "$WEB_DEPS_TAR" "https://github.com/rustdesk/doc.rustdesk.com/releases/download/console/web_deps.tar.gz"
fi

tar -xzf "$WEB_DEPS_TAR" -C "$SCRIPT_DIR/flutter/web/"

echo "=== Step 3: Installing JS dependencies and building connection bundle ==="
cd "$SCRIPT_DIR/flutter/web/js"
yarn install
yarn build

echo "=== Step 4: Getting Flutter dependencies ==="
cd "$SCRIPT_DIR/flutter"

$FLUTTER_CMD pub get

echo "=== Step 5: Compiling Flutter Web Application ==="
$FLUTTER_CMD build web --release --pwa-strategy=none --web-renderer canvaskit

echo "=== Step 6: Packaging JS bundle into Flutter build ==="
mkdir -p build/web/js
cp -r web/js/dist build/web/js/

if [[ "$ENABLE_WSS" == "true" ]]; then
  echo "=== Step 7: Patching WebSocket connections to use secure wss:// ==="
  find build/web/js/dist -type f -name "*.js" -exec perl -pi -e 's#ws://#wss://#g' {} +
fi

echo "=========================================================="
echo "Build complete! Static files are located at:"
echo "  $SCRIPT_DIR/flutter/build/web"
echo "=========================================================="
