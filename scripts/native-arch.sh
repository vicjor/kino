#!/bin/sh
# Puts node-datachannel's native binary for one macOS CPU in place, so the DMG for that CPU can load it.
#   scripts/native-arch.sh arm64 | x64
# bun install fetches the binary for the CPU it runs on (prebuild-install), and electron-builder packs node_modules as
# it is, so the other CPU's DMG would carry a binary its Mac cannot load. webtorrent imports node-datachannel at start
# (WebRTC peers), so the server inside that app would not start. Every other native module ships prebuilds for both
# CPUs. Run it again with this Mac's CPU after packaging, to put that one back.
set -e
cd "$(dirname "$0")/.."
arch=${1:-}
case $arch in arm64) want=arm64 ;; x64) want=x86_64 ;; *) echo "usage: scripts/native-arch.sh arm64 | x64" >&2; exit 2 ;; esac
bin=node_modules/node-datachannel/build/Release/node_datachannel.node
if [ -f "$bin" ] && file -b "$bin" | grep -q "$want"; then echo "node-datachannel for $arch: in place"; exit 0; fi
(cd node_modules/node-datachannel && ../.bin/prebuild-install -r napi --platform darwin --arch "$arch")
if ! file -b "$bin" | grep -q "$want"; then echo "node-datachannel for $arch: got $(file -b "$bin" 2>&1)" >&2; exit 1; fi
echo "node-datachannel for $arch: fetched"
