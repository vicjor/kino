#!/bin/sh
# The launchd agent for this checkout, to stdout: launchd/com.kino.plist.template with the real paths.
#   PORT=1234 KINO_DATA=~/kino-data sh scripts/plist.sh > ~/Library/LaunchAgents/com.kino.plist
# scripts/install.sh and make install-local write it. Needs Node on PATH.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-1234}
DATA=${KINO_DATA:-$HOME/kino-data}
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then echo "Node.js 26 or newer is required. Not found on PATH." >&2; exit 1; fi
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
# A version-manager shim (mise or asdf shims/node) needs that manager set up, which launchd is not: use the node it runs.
case "$NODE" in */shims/node) NODE=$("$NODE" -p process.execPath) ;; esac
# Keep a version alias such as mise's node/26 as it is: resolved to node/26.2.0 the plist breaks once a patch
# upgrade prunes that folder. A patch path (from a shim) goes back to its alias when the alias is the same install.
VER=$(dirname "$(dirname "$NODE")"); ALIAS=$(dirname "$VER")/$MAJOR
if [ "${VER##*/}" != "$MAJOR" ] && [ -x "$ALIAS/bin/node" ] && [ "$(cd "$ALIAS" && pwd -P)" = "$(cd "$VER" && pwd -P)" ]; then NODE=$ALIAS/bin/node; fi
sed -e "s|__NODE__|$NODE|g" -e "s|__NODE_DIR__|$(dirname "$NODE")|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__DATA__|$DATA|g" -e "s|__PORT__|$PORT|g" "$REPO/launchd/com.kino.plist.template"
