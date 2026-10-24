#!/bin/sh
# Puts a build in place by rename, never by writing over the dist/ the live server reads from.
#   scripts/swap-dist.sh DIR   DIR becomes dist/, the running build is kept as dist.prev/ (the one before it is dropped)
#   scripts/swap-dist.sh back  dist/ and dist.prev/ trade places: a rollback, and run again, a roll forward
# DIR must sit on the repo's volume (dist.new/ next to dist/), so each step is one rename. Restarting is the caller's job.
# Used by make deploy-local, make rollback-local and scripts/deploy-safe.sh.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
DIST=$REPO/dist; PREV=$REPO/dist.prev; TMP=$REPO/dist.new
whole() { [ -f "$1/server/index.js" ] && [ -f "$1/client/index.html" ]; }
trap '' INT TERM   # a few renames: finish them rather than stop halfway without a dist/

case ${1:-} in
  '') echo "usage: scripts/swap-dist.sh DIR | back" >&2; exit 2 ;;
  back)
    whole "$PREV" || { echo "No previous build to go back to: $PREV is missing or incomplete." >&2; exit 1; }
    if [ -e "$TMP" ]; then echo "$TMP exists: a deploy is building right now, or one was stopped. Wait for it, or remove $TMP." >&2; exit 1; fi
    if [ -d "$DIST" ]; then mv "$DIST" "$TMP"; fi
    if ! mv "$PREV" "$DIST"; then
      if [ -d "$TMP" ]; then mv "$TMP" "$DIST"; fi
      echo "Could not move $PREV to $DIST, nothing changed." >&2; exit 1
    fi
    if [ -d "$TMP" ]; then mv "$TMP" "$PREV"; fi
    ;;
  *)
    whole "$1" || { echo "$1 is not a whole build (it needs server/index.js and client/index.html), dist/ untouched." >&2; exit 1; }
    rm -rf "$PREV"
    if [ -d "$DIST" ]; then mv "$DIST" "$PREV"; fi
    if ! mv "$1" "$DIST"; then
      if [ -d "$PREV" ] && [ ! -d "$DIST" ]; then mv "$PREV" "$DIST"; fi
      echo "Could not move $1 to $DIST, the running build is still in place." >&2; exit 1
    fi
    ;;
esac
