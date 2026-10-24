#!/bin/sh
# Prints what a restart of Kino would interrupt right now, one word:
#   busy  someone is watching (the server's own /health "busy" flag)
#   idle  nobody is watching
#   down  /health does not answer at all (stopped, crashed or hung)
# Used by make deploy-guard and scripts/deploy-safe.sh. Usage: scripts/health-state.sh [URL]
URL=${1:-http://localhost:1234}
h=$(curl -fsS -m 5 "$URL/health" 2>/dev/null) || { echo down; exit 0; }
case $h in
  *'"busy":true'* | *'"busy": true'*) echo busy; exit 0 ;;
  *'"busy":false'* | *'"busy": false'*) echo idle; exit 0 ;;
esac
# No busy flag: a build from before it existed (until that ships once) or not Kino at all.
# Idle only when the old counters all read empty, busy otherwise.
# Remove after 2026-10-15: production runs a build without busy until its next deploy.
case $h in *'"cast":false'*) ;; *) echo busy; exit 0 ;; esac
case $h in *'"hlsSessions":0'[,}]*) ;; *) echo busy; exit 0 ;; esac
case $h in *'"streams":0'[,}]*) echo idle ;; *) echo busy ;; esac
