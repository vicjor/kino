#!/bin/sh
# One-shot install on a Mac: build, write a launchd agent with the real paths,
# start it, open the app. Needs Node 26 and bun (`mise install`). Re-run after `git pull`
# to update, or use `make deploy-safe`, which waits until nobody is watching.
#   PORT=1234 KINO_DATA=~/kino-data ./scripts/install.sh
# Refuses while someone is watching (it restarts Kino); FORCE=1 goes ahead anyway.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-1234}
DATA=${KINO_DATA:-$HOME/kino-data}
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then echo "Node.js 26 or newer is required. Not found on PATH. With mise: mise install (versions are pinned in mise.toml)."; exit 1; fi
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 26 ]; then echo "Node $MAJOR found, need 26 or newer. With mise: mise install (versions are pinned in mise.toml)."; exit 1; fi
if ! command -v bun >/dev/null 2>&1; then echo "bun is required to install and build Kino. Not found on PATH. With mise: mise install, or see https://bun.sh."; exit 1; fi
case "$(uname -s)" in Darwin) ;; *) echo "This installer is for macOS. On Linux use ops/kino.service (systemd)."; exit 1;; esac

# Installing restarts Kino, which stops every stream, video being converted and cast. Refuse while someone is watching.
PLIST="$HOME/Library/LaunchAgents/com.kino.plist"
if [ -z "$FORCE" ] && launchctl print "gui/$(id -u)/com.kino" >/dev/null 2>&1; then
  OLD_PORT=$(plutil -extract EnvironmentVariables.PORT raw "$PLIST" 2>/dev/null || echo "$PORT")
  if curl -fsS -m 5 "http://localhost:$OLD_PORT/health" 2>/dev/null | "$NODE" -e 'let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => {
    let h; try { h = JSON.parse(d); } catch { process.exit(1); }
    const n = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
    process.exit(h.busy === true || n(h.cast) > 0 || n(h.hlsSessions) > 0 || n(h.streams) > 0 ? 0 : 1);
  });'; then
    echo "Someone is watching on Kino right now. Installing restarts Kino and stops what is playing. Try again later, or run with FORCE=1 to go ahead anyway."; exit 1
  fi
fi

cd "$REPO"
echo "Installing dependencies (ffmpeg is downloaded here)..."
bun install --frozen-lockfile >/dev/null
# The npm binaries can be built for the wrong CPU (ffprobe-static's arm64 ffprobe is x86_64 and needs
# Rosetta). The server then uses Homebrew's, MacPorts' or the one on PATH; say so now if there is none of those either.
runs() { [ -n "$1" ] && "$1" -version >/dev/null 2>&1; }
for B in ffprobe ffmpeg; do
  if [ "$B" = ffprobe ]; then STATIC=$("$NODE" -p "require('ffprobe-static').path" 2>/dev/null || true); WHAT="videos will not start"
  else STATIC=$("$NODE" -p "require('ffmpeg-static')" 2>/dev/null || true); WHAT="videos that need converting will not play"; fi
  runs "$STATIC" && continue
  OTHER=
  for C in "/opt/homebrew/bin/$B" "/usr/local/bin/$B" "/opt/local/bin/$B" "$(command -v "$B" 2>/dev/null || true)"; do if runs "$C"; then OTHER=$C; break; fi; done
  if [ -n "$OTHER" ]; then echo "The bundled $B does not run on this Mac. Kino will use $OTHER."
  else echo "Kino cannot run $B on this Mac, so $WHAT. Install it with Homebrew: brew install ffmpeg, then run this script again."; fi
done
echo "Building..."
bun run build >/dev/null
mkdir -p "$DATA" "$HOME/Library/Logs/kino" "$HOME/Library/LaunchAgents"
PORT=$PORT KINO_DATA=$DATA sh scripts/plist.sh > "$PLIST"
launchctl bootout "gui/$(id -u)/com.kino" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
# The address phones use: en0, then en1, as the server picks it. /health has lanIp only without KINO_PIN or with the PIN cookie.
lan_ip() {
  ipconfig getifaddr en0 2>/dev/null && return
  ipconfig getifaddr en1 2>/dev/null && return
  curl -fsS -m 5 "http://localhost:$PORT/health" 2>/dev/null | sed -n 's/.*"lanIp":"\([^"]*\)".*/\1/p'
}
if curl -fsS -m 10 "http://localhost:$PORT/health" >/dev/null; then
  LAN=$(lan_ip); LAN=${LAN:-localhost}
  echo
  echo "Kino is running and starts with your Mac."
  echo "  This machine:  http://localhost:$PORT"
  echo "  Phones & TVs:  http://$LAN:$PORT"
  echo "  Data:          $DATA    Logs: ~/Library/Logs/kino/"
  open "http://localhost:$PORT" 2>/dev/null || true
else
  echo "Kino did not come up. Last log lines:"; tail -20 "$HOME/Library/Logs/kino/kino.error.log" 2>/dev/null; exit 1
fi
