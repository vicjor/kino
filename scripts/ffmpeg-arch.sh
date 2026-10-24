#!/bin/sh
# Fetches the ffmpeg and ffprobe the macOS DMG for one CPU ships, into vendor/ffmpeg/<arch>/.
#   scripts/ffmpeg-arch.sh arm64 | x64
# electron-builder copies that folder to Kino.app/Contents/Resources/ffmpeg (extraResources in package.json) and
# desktop/main.cjs points FFMPEG_BIN and FFPROBE_BIN at it. ffmpeg-static stays for production and dev, never the DMG:
# its macOS build is configured with --enable-nonfree, which FFmpeg says is not redistributable, and
# ffprobe-static's arm64 binary is an x86_64 build.
# The build is jellyfin-ffmpeg's portable one: GPL v3 (no nonfree), native per CPU, only macOS system libraries,
# with VideoToolbox, libx264, zscale and the native AAC encoder that server/media/hls.ts uses. Pinned by version
# and SHA-256. The GPL text and where the source is go next to the binaries.
set -e
cd "$(dirname "$0")/.."
VERSION=8.1.3-1
arch=${1:-}
case $arch in
  arm64) name=macarm64; sum=22445d7299742749ad2eeb9ce87963d50def0357e45b3e6c7b69987c8365dbf6; want='arm64' ;;
  x64) name=mac64; sum=cb2b5c154d49a6b6bfe29fa6c16510e85dcbf60b805764121a167b093d4bb6fb; want='x86_64' ;;
  *) echo "usage: scripts/ffmpeg-arch.sh arm64 | x64" >&2; exit 2 ;;
esac
out=vendor/ffmpeg/$arch
if [ -f "$out/.version" ] && [ "$(cat "$out/.version")" = "$VERSION" ]; then echo "ffmpeg for $arch: $VERSION already in $out"; exit 0; fi
tar=jellyfin-ffmpeg_${VERSION}_portable_${name}-gpl.tar.xz
tmp=$(mktemp -d "${TMPDIR:-/tmp}/kino-ffmpeg.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$tar" "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v$VERSION/$tar"
got=$(shasum -a 256 "$tmp/$tar" | cut -d' ' -f1)
if [ "$got" != "$sum" ]; then echo "SHA-256 mismatch for $tar: $got" >&2; exit 1; fi
curl -fsSL -o "$tmp/COPYING.GPLv3" https://www.gnu.org/licenses/gpl-3.0.txt
rm -rf "$out"; mkdir -p "$out"
tar -xJf "$tmp/$tar" -C "$out" ffmpeg ffprobe
for b in ffmpeg ffprobe; do
  if ! file -b "$out/$b" | grep -q "$want"; then echo "$b in $tar is not $want: $(file -b "$out/$b")" >&2; rm -rf "$out"; exit 1; fi
done
cp "$tmp/COPYING.GPLv3" "$out/"
cat > "$out/README.txt" <<EOF
ffmpeg and ffprobe: jellyfin-ffmpeg $VERSION, portable macOS build ($name, GPL v3), included unchanged.
Kino runs them as separate programs and does not link against them.
Licence: COPYING.GPLv3 in this folder.
Source: https://github.com/jellyfin/jellyfin-ffmpeg/tree/v$VERSION
Build: https://github.com/jellyfin/jellyfin-ffmpeg/releases/tag/v$VERSION
EOF
echo "$VERSION" > "$out/.version"
echo "ffmpeg for $arch: jellyfin-ffmpeg $VERSION in $out"
