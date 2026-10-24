# Kino on a Mac, run by launchd from this checkout: the dist/ here is what it serves.
# make install-local once, then make deploy-safe after each git pull.
LABEL     := com.kino
LOCAL_URL := http://localhost:1234
LAN_URL   := http://$(shell ipconfig getifaddr en0 2>/dev/null || echo localhost):1234

.PHONY: help dev build test typecheck install install-local locked-install-local restart-guard deploy-guard deploy-local locked-deploy-local deploy-safe rollback-local locked-rollback-local start-local stop-local logs-local status-local cache-usage open

help:
	@echo "make dev            server (tsx watch) on :1234 + vite dev server on :5173"
	@echo "make build          compile server + client into dist/ (in place: the live server reads it)"
	@echo "make test           unit tests (node:test)"
	@echo "make typecheck      tsc --noEmit for server + client"
	@echo "make install        first-time setup on any Mac: deps, build, launchd agent with real paths, start (scripts/install.sh)"
	@echo "make install-local  first-time setup on this Mac: build into dist.new/ and swap it in (previous build kept in"
	@echo "                    dist.prev), data + log dirs, copy plist, launchd bootout + bootstrap, wait for /health from the"
	@echo "                    new process. Holds the deploy lock: refuses while another deploy runs, or if someone is"
	@echo "                    watching before or after the build (FORCE=1)"
	@echo "make deploy-local  PRODUCTION NOW: guard, build the working tree into dist.new/, swap it in by rename (previous"
	@echo "                    build kept in dist.prev), restart"
	@echo "                    holds the deploy lock: refuses while deploy-safe or another deploy runs, if someone is watching"
	@echo "                    before or after the build (FORCE=1)"
	@echo "                    or server/ client/ have uncommitted changes (DIRTY=1). A server that does not answer is"
	@echo "                    restarted anyway, with a warning"
	@echo "make deploy-guard   only the deploy-local checks: no build, no restart"
	@echo "make deploy-safe    waits until nobody has watched for IDLE_MIN=5 minutes in a row (gives up after MAX_WAIT_MIN=720),"
	@echo "                    then builds committed HEAD in a throwaway worktree, checks again (waits again if someone"
	@echo "                    started watching), swaps dist/ (previous build kept in dist.prev, rollback command printed),"
	@echo "                    restarts. Runs in the foreground, one deploy at a time (deploy-local and rollback-local share"
	@echo "                    its lock). Build log: ~/Library/Logs/kino/deploy-safe.log"
	@echo "make rollback-local PRODUCTION NOW: dist/ and dist.prev/ trade places, restart, check /health. Run again to go"
	@echo "                    forward. Holds the deploy lock: refuses while deploy-safe or another deploy runs, or someone"
	@echo "                    is watching (FORCE=1)"
	@echo "make start-local    load + start the launchd agent, wait for /health. A running one is left alone (no restart)"
	@echo "make stop-local     unload the launchd agent, wait for port 1234 to free (comes back at next login). Refuses"
	@echo "                    while a deploy runs, or if someone is watching (FORCE=1)"
	@echo "make logs-local     follow kino.log (info) + kino.error.log (warn, error)"
	@echo "make status-local   launchd state + health"
	@echo "make cache-usage    free disk, torrent cache and HLS usage, per torrent"
	@echo "make open           open Kino in the browser ($(LAN_URL))"

dev:
	bun run dev

build:
	bun run build

test:
	bun run test

typecheck:
	bun run typecheck

install:
	@scripts/install.sh

# The reload stops whatever is playing. Like deploy-local: holds the deploy lock guard to restart, restart-guard goes
# first so a refusal builds nothing, then BUILD_SWAP (checked again after the build, FORCE=1 overrides both).
install-local:
	@sh scripts/deploy-lock.sh run "make install-local" $(MAKE) --no-print-directory locked-install-local

locked-install-local: GUARD_HINT = or once nobody is watching
locked-install-local: restart-guard
	$(LOCKED)
	@$(BUILD_SWAP)
	@mkdir -p ~/kino-data ~/Library/Logs/kino ~/Library/LaunchAgents
	@sh scripts/plist.sh > ~/Library/LaunchAgents/$(LABEL).plist
	@$(RESTART) reload && echo "Kino is live at $(LAN_URL)"

deploy-safe:
	@scripts/deploy-safe.sh

# Shared by deploy-local, rollback-local and install-local, which all restart the service, and stop-local:
# Refuses while another process holds the deploy lock (scripts/deploy-lock.sh): make deploy-safe, or another deploy-local,
# rollback-local or install-local. They swap dist/ and restart too. FORCE does not override. Under the lock, its own
# holder passes.
# Refuses while someone is watching (/health busy: a cast, a transcoder or a stream). FORCE=1 overrides.
# A /health that does not answer is said out loud, then it goes on: restarting a dead server is the point.
# GUARD_WHY says what it would break, GUARD_HINT the way out it offers next to FORCE=1 (install-local and stop-local set
# their own).
GUARD_WHY = a restart stops it
GUARD_HINT = or deploy with make deploy-safe (it waits)
restart-guard:
	@sh scripts/deploy-lock.sh check
	@state=$$(sh scripts/health-state.sh $(LOCAL_URL)); \
	if [ "$$state" = down ]; then echo "Warning: server down, $(LOCAL_URL)/health does not answer. Going ahead anyway."; fi; \
	if [ "$$state" = busy ] && [ -z "$(FORCE)" ]; then echo "Someone is watching (cast, transcoder or stream) and $(GUARD_WHY). Re-run with FORCE=1, $(GUARD_HINT)."; exit 1; fi

# Runs before the build, so a refused deploy builds nothing.
# Refuses when server/ or client/ differ from HEAD: the build ships the working tree. DIRTY=1 overrides.
deploy-guard: restart-guard
	@if [ -z "$(DIRTY)" ] && ! git diff --quiet HEAD -- server client; then \
	echo "Uncommitted changes in server/ or client/ would ship with this build:"; git status --short -- server client; \
	echo "Commit them first, or re-run with DIRTY=1 to ship them anyway. make deploy-safe ships committed HEAD only."; exit 1; fi

# The deploy lock is held for the whole run, guard to restart: deploy-local, rollback-local and install-local run their
# locked- target in a sub-make under scripts/deploy-lock.sh. FORCE and DIRTY reach it through MAKEFLAGS.
LOCKED = @[ -n "$$KINO_DEPLOY_LOCK_PID" ] || { echo "Run make $(@:locked-%=%): it holds the deploy lock."; exit 1; }

# scripts/restart.sh restarts the service (or loads it when make stop-local unloaded it), then waits for a /health
# whose uptime says it comes from the new process: the old one keeps answering while it shuts down.
# install-local adds reload (bootout, bootstrap the new plist), start-local adds start (a running one is left alone),
# stop-local adds stop (bootout, wait for the port to free).
RESTART = LABEL=$(LABEL) sh scripts/restart.sh $(LOCAL_URL)

# BUILD_SWAP (deploy-local, install-local) builds the working tree into dist.new/ next to dist/, so the live server keeps
# a whole dist/ until the swap (vite empties its outDir first). The build takes a while, so /health is checked again
# before the swap (FORCE=1 overrides, GUARD_HINT is the other way out). The swap is two renames (scripts/swap-dist.sh,
# no dist/ yet is fine) and the previous build stays in dist.prev for make rollback-local.
# A build whose sw.js pre-caches a file it lacks is refused (scripts/check-sw.ts, as in build:check): that one 404
# would fail every phone's service worker update.
BUILD_SWAP = rm -rf dist.new; trap 'rm -rf dist.new' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; \
	bun run build:server --outDir "$(CURDIR)/dist.new/server" && \
	bun run build:client --outDir "$(CURDIR)/dist.new/client" --emptyOutDir || exit 1; \
	bun scripts/verify-build.ts dist.new/client || { echo "Nothing changed: this build fails its checks (above)."; exit 1; }; \
	if [ "$$(sh scripts/health-state.sh $(LOCAL_URL))" = busy ] && [ -z "$(FORCE)" ]; then \
	echo "Someone started watching during the build. Nothing changed. Re-run with FORCE=1, $(GUARD_HINT)."; exit 1; fi; \
	sh scripts/swap-dist.sh dist.new

# The guard is a prerequisite, so it finishes before the build even under make -j.
deploy-local:
	@sh scripts/deploy-lock.sh run "make deploy-local" $(MAKE) --no-print-directory locked-deploy-local

locked-deploy-local: deploy-guard
	$(LOCKED)
	@$(BUILD_SWAP)
	@$(RESTART) && echo "Updated. $(LAN_URL) (make rollback-local puts the previous build back)"

# Puts the previous build back: dist/ and dist.prev/ trade places by rename, so running it again goes forward.
rollback-local:
	@sh scripts/deploy-lock.sh run "make rollback-local" $(MAKE) --no-print-directory locked-rollback-local

locked-rollback-local: restart-guard
	$(LOCKED)
	@sh scripts/swap-dist.sh back
	@$(RESTART) && echo "Rolled back. $(LAN_URL) (make rollback-local again goes forward)"

start-local:
	@$(RESTART) start && echo "Kino is up at $(LAN_URL)"

# Stopping ends whatever is playing, so it refuses like a restart (restart-guard, FORCE=1 overrides).
stop-local: GUARD_WHY = stopping Kino ends it
stop-local: GUARD_HINT = or once nobody is watching
stop-local: restart-guard
	@$(RESTART) stop

logs-local:
	@tail -n 40 -F ~/Library/Logs/kino/kino.log ~/Library/Logs/kino/kino.error.log

status-local:
	@launchctl print gui/$$(id -u)/$(LABEL) 2>/dev/null | grep -E "state =|pid =" || echo "$(LABEL) not loaded"
	@curl -fsS -m 10 $(LOCAL_URL)/health | python3 -m json.tool || echo "health: DOWN"

cache-usage:
	@curl -fsS -m 10 $(LOCAL_URL)/api/disk | python3 -c 'import json,sys; d=json.load(sys.stdin); G=2**30; print(f"free {d[\"freeBytes\"]/G:.1f} GB  cache {d[\"cacheBytes\"]/G:.2f}/{d[\"cacheCapBytes\"]/G:.0f} GB  hls {d[\"hlsBytes\"]/2**20:.0f} MB"); [print(f"  {e[\"bytes\"]/G:6.2f} GB  {e[\"name\"][:60]}") for e in d["entries"]]'

open:
	open $(LAN_URL)
