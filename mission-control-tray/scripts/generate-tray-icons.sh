#!/usr/bin/env bash
# Generate Tauri bundle icons + menu-bar tray icons from brand logo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="${EDGE_ICON_SOURCE:-$ROOT/../mission-control/public/brand/app-logo.png}"
ICONS="$ROOT/src-tauri/icons"

if [[ ! -f "$SRC" ]]; then
  echo "error: brand logo not found: $SRC" >&2
  exit 1
fi

command -v convert >/dev/null || { echo "error: ImageMagick convert required" >&2; exit 1; }

mkdir -p "$ICONS"

echo "==> source: $SRC"

# Bundle / Dock / app icon sizes (color, transparent padding)
for size in 32 128 256 512; do
  convert "$SRC" \
    -resize "${size}x${size}" \
    -background none \
    -gravity center \
    -extent "${size}x${size}" \
    "$ICONS/${size}x${size}.png"
done

cp "$ICONS/512x512.png" "$ICONS/icon.png"
cp "$ICONS/256x256.png" "$ICONS/128x128.png"
cp "$ICONS/512x512.png" "$ICONS/128x128@2x.png"

# macOS .icns (optional if iconutil available)
if command -v iconutil >/dev/null; then
  ICONSET="$ICONS/icon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    convert "$SRC" -resize "${size}x${size}" -background none -gravity center -extent "${size}x${size}" \
      "$ICONSET/icon_${size}x${size}.png"
    double=$((size * 2))
    convert "$SRC" -resize "${double}x${double}" -background none -gravity center -extent "${double}x${double}" \
      "$ICONSET/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$ICONSET" -o "$ICONS/icon.icns"
  rm -rf "$ICONSET"
fi

# Windows .ico
convert "$ICONS/32x32.png" "$ICONS/128x128.png" "$ICONS/256x256.png" "$ICONS/icon.ico"

# Menu bar / 托盘 — 与 app-logo 一致（彩色、透明底）
convert "$SRC" -resize 22x22 -background none -gravity center -extent 22x22 "$ICONS/tray-icon.png"
convert "$SRC" -resize 44x44 -background none -gravity center -extent 44x44 "$ICONS/tray-icon@2x.png"
cp "$ICONS/tray-icon.png" "$ICONS/menu-bar-tray.png"
cp "$ICONS/tray-icon@2x.png" "$ICONS/menu-bar-tray@2x.png"

# macOS template（可选 MC_EDGE_TRAY_TEMPLATE=1：系统随深浅色反色）
convert "$SRC" -resize 18x18 -background none -gravity center -extent 18x18 \
  -colorspace Gray -gamma 0.65 -contrast-stretch 2%x98% \
  -channel RGB -fill black -colorize 100% \
  +channel -alpha on \
  -type TrueColorAlpha \
  PNG32:"$ICONS/tray-icon-template@1x.png"
convert "$ICONS/tray-icon-template@1x.png" -resize 36x36 PNG32:"$ICONS/tray-icon-template.png"

# Tauri 托盘 .ico（由品牌 template 导出，与 Dock 图标同源）
convert "$ICONS/tray-icon-template@1x.png" \
  -define icon:auto-resize=16,18,22,32,44,48 \
  "$ICONS/tray-icon-mono.ico"

echo "==> wrote icons under $ICONS"
echo "    tray: tray-icon*.png, menu-bar-tray*.png (同 app-logo), tray-icon-mono.ico"
