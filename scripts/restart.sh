#!/bin/sh
# Restarts the launchd service (or loads it, when make stop-local unloaded it), then waits up to WAIT_S tries,
# a second apart, for a /health that comes from the new process: the old one keeps answering while it shuts
# down, so "it answers" is not enough. The proof is /health's uptime (in the short reply a PIN gives too):
# no older than the restart. On a timeout it prints the end of kino.error.log and exits 1.
# Every launchd wait for Kino lives here (stop as well), WAIT_S tries each.
# Usage: scripts/restart.sh [URL] [restart | start | reload | stop]
#   restart (default): kickstart -k a loaded service. make deploy-local, make rollback-local, scripts/deploy-safe.sh.
#   start: never stops a running service, only waits for its /health; starts a loaded one that is not running.
#          make start-local.
#   reload: bootout, wait until launchd lets go, bootstrap the plist again (a new plist takes effect). make install-local.
#   stop: bootout, wait until launchd lets go and nothing listens on URL's port. make stop-local. It comes back at login.
# All but stop bootstrap the plist when the service is not loaded.
URL=${1:-http://localhost:1234}
HOW=${2:-restart}
LABEL=${LABEL:-com.kino}
WAIT_S=${WAIT_S:-30}
ERROR_LOG=${KINO_ERROR_LOG:-$HOME/Library/Logs/kino/kino.error.log}
case $HOW in restart | start | reload | stop) ;; *) echo "usage: scripts/restart.sh [URL] [restart | start | reload | stop]" >&2; exit 2 ;; esac

domain="gui/$(id -u)"; svc="$domain/$LABEL"; plist="$HOME/Library/LaunchAgents/$LABEL.plist"
loaded() { launchctl print "$svc" >/dev/null 2>&1; }
# bootout, then wait until launchd lets go. $1 ends the sentence when it never does.
unload() {
  launchctl bootout "$svc" 2>/dev/null
  i=0
  while loaded; do
    i=$((i+1))
    if [ "$i" -ge "$WAIT_S" ]; then echo "launchd still has $LABEL loaded after bootout, $1"; exit 1; fi
    sleep 1
  done
}

if [ "$HOW" = stop ]; then
  port=${URL##*:}; port=${port%%/*}
  case $port in '' | *[!0-9]*) port=80 ;; esac
  if loaded; then unload "so Kino may still be running."; else echo "$LABEL was not loaded"; fi
  i=0
  while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    i=$((i+1))
    if [ "$i" -ge "$WAIT_S" ]; then echo "Kino is still holding port $port"; exit 1; fi
    sleep 1
  done
  echo "Kino stopped on this Mac, port $port is free"; exit 0
fi

t0=$(date +%s); done_what=Restarted; from=' from the new process'
if [ "$HOW" = reload ] && loaded; then unload "so $plist was not loaded again."; fi
if ! loaded; then
  if [ ! -f "$plist" ]; then echo "$LABEL is not loaded and there is no $plist to load. make install-local puts it there."; exit 1; fi
  [ "$HOW" = reload ] || echo "Service was not loaded (stopped earlier), bootstrapping it"
  launchctl bootstrap "$domain" "$plist"; done_what=Started
elif [ "$HOW" = restart ]; then launchctl kickstart -k "$svc"
elif launchctl print "$svc" 2>/dev/null | grep -q 'state = running'; then echo "Already running, not restarted"; t0=0; done_what=Running; from=
else launchctl kickstart "$svc"; done_what=Started; fi
i=0
until up=$(curl -fsS -m 5 "$URL/health" 2>/dev/null | sed -n 's/.*"uptime":\([0-9]*\).*/\1/p') && [ -n "$up" ] && [ "$up" -le $(($(date +%s) - t0 + 1)) ]; do
  i=$((i+1))
  if [ "$i" -ge "$WAIT_S" ]; then
    echo "$done_what, but $URL/health does not answer$from. Last lines of $ERROR_LOG:"
    tail -n 20 "$ERROR_LOG" 2>/dev/null; exit 1
  fi
  sleep 1
done
