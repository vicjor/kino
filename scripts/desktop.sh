#!/bin/sh
# bun run desktop (build, then the Electron app) and bun run desktop:dist (build, then an arm64 and an x64 DMG into release/).
#   scripts/desktop.sh run | dist
# Both build dist/, which the app loads and the DMG packs. In a checkout the launchd Kino serves (the WorkingDirectory
# of ~/Library/LaunchAgents/com.kino.plist) that is the dist/ production serves from disk, so both refuse there unless
# DEPLOY=1: run them in a git worktree. Any other checkout, a fresh clone included, just builds.
# run, in a worktree: the embedded server goes on :1299 with a throwaway data folder (removed on exit), not :1234,
# where it would find production answering /health and attach to it, data and all. PORT and KINO_DATA override.
# Electron gets a throwaway folder of its own too (KINO_USER_DATA, removed on exit): with Kino.app's, it would find
# Kino.app's single-instance lock held and quit while Kino.app runs.
# dist refuses a symlinked node_modules (a worktree borrowing the main checkout's): electron-builder packs
# node_modules into the app, so the DMG needs this checkout's own bun install.
set -e
cd "$(dirname "$0")/.."
mode=${1:-}
case $mode in run | dist) ;; *) echo "usage: scripts/desktop.sh run | dist" >&2; exit 2 ;; esac

gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null || true)
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
worktree=; if [ -n "$gitdir" ] && [ "$gitdir" != "$common" ]; then worktree=1; fi
plist=$HOME/Library/LaunchAgents/com.kino.plist
served=$(plutil -extract WorkingDirectory raw "$plist" 2>/dev/null || true)
if [ -n "$served" ]; then served=$(cd "$served" 2>/dev/null && pwd -P || true); fi
if [ -z "$worktree" ] && [ "$served" = "$(pwd -P)" ] && [ "${DEPLOY:-}" != 1 ]; then
  echo "Refusing: launchd serves Kino from this checkout, and bun run build rewrites the dist/ it serves. Run it in a git worktree, or set DEPLOY=1." >&2; exit 1
fi
if [ "$mode" = dist ] && [ -L node_modules ]; then
  echo "Refusing: node_modules is a symlink (to $(readlink node_modules)) and electron-builder packs it into the app. Give this checkout its own install first: rm node_modules && bun install" >&2; exit 1
fi

bun run build
if [ "$mode" = dist ]; then
  # One DMG per CPU, each packing that CPU's ffmpeg from vendor/ffmpeg (scripts/ffmpeg-arch.sh). The `dmg` target on
  # the command line makes electron-builder build only the arch given; without it, it builds every arch in mac.target each time.
  for arch in arm64 x64; do
    sh scripts/ffmpeg-arch.sh "$arch"
    electron-builder --mac dmg --"$arch" --publish never
  done
  exit 0
fi

if [ -n "$worktree" ]; then
  PORT=${PORT:-1299}; KINO_HOSTNAME=${KINO_HOSTNAME:-off}; KINO_PLAIN_PORT=${KINO_PLAIN_PORT:-0}
  made_data=; made_app=
  if [ -z "${KINO_DATA:-}" ]; then KINO_DATA=$(mktemp -d "${TMPDIR:-/tmp}/kino-desktop.XXXXXX"); made_data=$KINO_DATA; fi
  if [ -z "${KINO_USER_DATA:-}" ]; then KINO_USER_DATA=$(mktemp -d "${TMPDIR:-/tmp}/kino-desktop-app.XXXXXX"); made_app=$KINO_USER_DATA; fi
  trap 'rm -rf ${made_data:+"$made_data"} ${made_app:+"$made_app"}' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
  KINO_LOG_FILE=${KINO_LOG_FILE:-$KINO_DATA/kino.log}
  export PORT KINO_HOSTNAME KINO_PLAIN_PORT KINO_DATA KINO_LOG_FILE KINO_USER_DATA
  echo "desktop: worktree, server on :$PORT with data in $KINO_DATA, app folder $KINO_USER_DATA"
fi
electron .
