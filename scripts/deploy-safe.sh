#!/bin/sh
# Restart only when nobody is watching: a restart drops HLS sessions, open file
# streams and the cast session. Waits until /health has said idle (busy
# false; background downloads resume after a restart) for IDLE_MIN minutes in a
# row, then builds HEAD (committed code only, in a throwaway worktree, so
# half-edited files never ship) and refuses a build whose service worker would
# pre-cache a file it lacks (scripts/check-sw.ts). The build takes a while, so
# it checks /health again and waits again if someone started watching. Then it
# swaps dist/ by rename (scripts/swap-dist.sh; the previous build stays in
# dist.prev for make rollback-local), restarts the service and waits for the
# new process's /health (scripts/restart.sh).
# One deploy at a time: it holds the deploy lock (scripts/deploy-lock.sh) for
# the whole run, and make deploy-local and rollback-local refuse meanwhile
# (they hold it too while they run). Build output goes to
# ~/Library/Logs/kino/deploy-safe.log; its tail is printed if the build fails.
set -e
URL=${URL:-http://localhost:1234}
IDLE_MIN=${IDLE_MIN:-5}
MAX_WAIT_MIN=${MAX_WAIT_MIN:-720}
REPO=$(cd "$(dirname "$0")/.." && pwd)
LOGDIR=$HOME/Library/Logs/kino
BUILD_LOG=$LOGDIR/deploy-safe.log
cd "$REPO"

# Always drop the throwaway worktree, an unswapped dist.new and our lock, whatever way we exit.
WT=; NEW=; LOCKED=
cleanup() {
  rc=$?
  if [ -n "$WT" ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
    git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  fi
  if [ -n "$NEW" ]; then   # stopped mid-swap: put the running build back before dropping the new one
    if [ ! -d "$REPO/dist" ] && [ -d "$REPO/dist.prev" ]; then mv "$REPO/dist.prev" "$REPO/dist"; fi
    rm -rf "$NEW"
  fi
  if [ -n "$LOCKED" ]; then sh "$REPO/scripts/deploy-lock.sh" drop $$; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Refuses, saying who, while another deploy holds it. A lock whose pid is gone is stale and gets cleared.
sh "$REPO/scripts/deploy-lock.sh" take "make deploy-safe" $$ || exit 1
LOCKED=1

# make hands us the calling shell's PATH, which may lack mise shims. Try PATH, then
# the version pinned in mise.toml, then the given fallback. Resolved up front so a
# missing tool fails now, not after hours of waiting.
find_tool() {
  p=$(command -v "$1" 2>/dev/null) || p=$(mise which "$1" 2>/dev/null) || p=$(/opt/homebrew/bin/mise which "$1" 2>/dev/null) || p=${2:-}
  if [ -n "$p" ] && [ -x "$p" ]; then echo "$p"; else return 1; fi
}
BUN=$(find_tool bun "$HOME/.bun/bin/bun") || { echo "deploy-safe: bun not found on PATH, via mise or in ~/.bun/bin"; exit 1; }
NODE=$(find_tool node) || NODE=   # optional: bun stands in for node when there is none
PATH=$(dirname "$BUN")${NODE:+:$(dirname "$NODE")}:$PATH; export PATH

# busy, idle or down, from /health's own busy flag (scripts/health-state.sh).
health() { sh "$REPO/scripts/health-state.sh" "$URL"; }
# Returns once /health has read idle IDLE_MIN times in a row, a minute apart. A server that does not
# answer counts as idle (nobody can be watching it), but says so. MAX_WAIT_MIN covers every wait of the run.
waited=0
wait_idle() {
  idle_streak=0
  while :; do
    state=$(health)
    if [ "$state" = busy ]; then idle_streak=0; else idle_streak=$((idle_streak+1)); fi
    [ "$idle_streak" -ge "$IDLE_MIN" ] && return 0
    case $state in
      busy) echo "$(date +%H:%M) someone is watching, waiting" ;;
      down) echo "$(date +%H:%M) server not answering, counted as idle ${idle_streak}/${IDLE_MIN} min" ;;
      *) echo "$(date +%H:%M) idle ${idle_streak}/${IDLE_MIN} min" ;;
    esac
    if [ "$waited" -ge "$MAX_WAIT_MIN" ]; then echo "still busy after ${MAX_WAIT_MIN} min, giving up"; exit 1; fi
    waited=$((waited+1)); sleep 60
  done
}

git diff --quiet HEAD -- server client || echo "deploy-safe: note, uncommitted server/client changes are NOT shipped (committed HEAD only)"
echo "deploy-safe: will ship HEAD (now $(git rev-parse --short HEAD)) after ${IDLE_MIN} idle minutes (no cast, no transcoder, no viewer). Ctrl+C to abort (make deploy-local and rollback-local refuse while this runs)."
wait_idle

REV=$(git rev-parse HEAD); SHORT=$(git rev-parse --short "$REV")
mkdir -p "$LOGDIR"
WT=$(mktemp -d /tmp/kino-deploy.XXXXXX)
git worktree add -q --detach "$WT" "$REV"
ln -s "$REPO/node_modules" "$WT/node_modules"
echo "$(date '+%F %T') deploy-safe: building $SHORT with $BUN" >"$BUILD_LOG"
if ! ( cd "$WT" && "$BUN" run build ) >>"$BUILD_LOG" 2>&1; then
  echo "deploy-safe: build of $SHORT failed, nothing shipped, service untouched. Last lines of $BUILD_LOG:"
  tail -n 40 "$BUILD_LOG"; exit 1
fi
# The build passes even when sw.js pre-caches a file it lacks, and one such 404 fails every phone's service worker
# update. HEAD's scripts/verify-build.ts (every check build:check runs) catches it before anything ships.
if ! sw=$(cd "$WT" && "${NODE:-$BUN}" scripts/verify-build.ts dist/client 2>&1); then
  echo "$sw" >>"$BUILD_LOG"
  echo "deploy-safe: build of $SHORT fails its checks, nothing shipped, service untouched:"
  echo "$sw"; exit 1
fi
echo "$sw" >>"$BUILD_LOG"
# Copy next to dist/ (same volume) so the swap below is two renames, not a delete and a copy.
NEW=$REPO/dist.new
rm -rf "$NEW"; cp -R "$WT/dist" "$NEW"
git worktree remove --force "$WT"; WT=
# The idle wait ended before the build: check again right before the restart.
while [ "$(health)" = busy ]; do
  echo "$(date +%H:%M) someone started watching during the build, waiting again"
  wait_idle
done
sh "$REPO/scripts/swap-dist.sh" "$NEW"; NEW=
restarted=1; sh "$REPO/scripts/restart.sh" "$URL" || restarted=
if [ -d "$REPO/dist.prev" ]; then
  echo "deploy-safe: previous build kept in dist.prev. To roll back: cd '$REPO' && make rollback-local"
  echo "  (without make: sh scripts/swap-dist.sh back && sh scripts/restart.sh)"
fi
if [ -z "$restarted" ]; then echo "deploy-safe: restarted with $SHORT, but the new process never answered /health (above)"; exit 1; fi
echo "deployed $SHORT after ${waited} min idle wait"
