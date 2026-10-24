#!/bin/sh
# One deploy at a time. make deploy-safe, deploy-local, rollback-local and install-local all swap dist/ and restart
# Kino, so each holds this lock for its whole run (make stop-local only checks it): a mkdir lock in the git dir (shared
# by every worktree) with the holder's pid and name inside. A lock whose pid is gone is stale and the next take clears it.
#   scripts/deploy-lock.sh take NAME PID   take it for PID (deploy-safe passes its own), or say who holds it and fail
#   scripts/deploy-lock.sh drop PID        let it go, only if PID holds it
#   scripts/deploy-lock.sh check           fail, saying who, while another live process holds it
#   scripts/deploy-lock.sh run NAME CMD..  take it, run CMD, let it go; CMD's own check passes (KINO_DEPLOY_LOCK_PID)
# KINO_DEPLOY_LOCK overrides the lock path (tests).
LOCK=${KINO_DEPLOY_LOCK:-}
if [ -z "$LOCK" ]; then
  common=$(git -C "$(dirname "$0")/.." rev-parse --path-format=absolute --git-common-dir) || { echo "deploy-lock: no git dir found for the lock" >&2; exit 1; }
  LOCK=$common/kino-deploy-safe.lock
fi

# pid and name of the holder. A lock from before names were written is deploy-safe's.
holder() { pid=$(cat "$LOCK/pid" 2>/dev/null || true); name=$(cat "$LOCK/name" 2>/dev/null || true); name=${name:-make deploy-safe}; }
refuse() {
  if [ -z "$pid" ]; then echo "Another deploy holds the lock but wrote no pid. If nothing is deploying, remove it: rm -rf '$LOCK'"
  else case $name in
    *deploy-safe*) echo "$name is running (pid $pid) and deploys once nobody is watching. Let it finish, or stop it first: kill $pid" ;;
    *) echo "$name is running (pid $pid): it restarts Kino too. Let it finish." ;;
  esac; fi
  return 1
}

take() {
  if ! mkdir "$LOCK" 2>/dev/null; then
    holder
    if [ -z "$pid" ] || kill -0 "$pid" 2>/dev/null; then refuse; return 1; fi
    echo "Clearing a stale deploy lock left by $name (pid $pid)"; rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { holder; refuse; return 1; }
  fi
  echo "$1" >"$LOCK/name"; echo "$2" >"$LOCK/pid"
}

check() {
  [ -d "$LOCK" ] || return 0
  holder
  if [ -n "$pid" ] && { [ "$pid" = "${KINO_DEPLOY_LOCK_PID:-}" ] || ! kill -0 "$pid" 2>/dev/null; }; then return 0; fi
  refuse
}

drop() { if [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$1" ]; then rm -rf "$LOCK"; fi; }

usage() { echo "usage: scripts/deploy-lock.sh take NAME PID | drop PID | check | run NAME CMD [ARGS...]" >&2; exit 2; }
case ${1:-} in
  take) [ $# -eq 3 ] || usage; take "$2" "$3" ;;
  drop) [ $# -eq 2 ] || usage; drop "$2" ;;
  check) [ $# -eq 1 ] || usage; check ;;
  run)
    [ $# -ge 3 ] || usage; shift; what=$1; shift
    take "$what" $$ || exit 1
    trap 'drop $$' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
    KINO_DEPLOY_LOCK_PID=$$; export KINO_DEPLOY_LOCK_PID
    "$@"
    ;;
  *) usage ;;
esac
