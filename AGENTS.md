# Kino: Agent Instructions

Self-hosted media player for the home LAN. One Node process, React client, server-side casting to Chromecasts (castv2) and DLNA TVs. Read [README.md](README.md) first; design notes with the reasoning behind parts of it are in `docs/specs/`, and new specs go there too.

Owner-specific notes (which machine runs production, the devices in the house) live in `CLAUDE.local.md`, which is gitignored. Read it when it exists.

## This repo is public

Everything committed here, including commit messages, is published. Kino stays a media player:

- **No bundled or recommended torrent indexers, ever.** `DEFAULT_ADDONS` (`server/config.ts`) and the addon catalog in `addons.ts` hold metadata and subtitle addons only, and the catalog never lists stream addons. Do not name indexers, torrent sites, stream addons, release-group sites or any other source of content in code, tests, docs, screenshots, copy or commit messages. Test fixtures use made-up release names and `example.com`.
- Kino plays files the user picks, not live broadcasts.
- Screenshots show only openly licensed or public domain films as watched (Blender films, public domain classics). Block `/api/cast/*` and `/api/events` while shooting, or the real TVs on the network show up.
- No personal details: no real LAN addresses (tests use `192.168.1.x`), host names, tailnet names, device names, user paths or e-mail addresses. No secrets: there are none today (the Home Assistant webhook URL lives in `state.json`, never in code).
- Commit as the owner's normal git identity; never add co-author lines that name a person.

## Running Kino from a checkout

- When launchd (`com.kino`, written by `scripts/install.sh` or `make install-local` from `launchd/com.kino.plist.template`) serves this checkout, **its `dist/` is production**. GitHub is version control only: pushing deploys nothing.
- Runtime data in `~/kino-data/` (`KINO_DATA`): `state.json`, `cache/`, `hls/`, `subs/`, `imdb/` (IMDb dataset dumps), `discover.json` (Home rails), `dlna-known.json`, `dlna-asked.json`, `lg-keys.json` (0600, the key an LG TV hands Kino when you press Allow, so the power button turns it off), `secret.key` (0600, made on first use: signs subtitle ids and derives the PIN cookie; moves with `state.json`), `state.json.corrupt-<ms>` (an unreadable state moved aside, newest 3 kept), `state.json.bak` (the bytes before a load repaired or pruned them), `picks.jsonl` (sources played from a list, with what Auto picked, then any stall, switch or early stop in the player: `scripts/pick-agreement.ts` reads it; at most 4 MB). Logs: `~/Library/Logs/kino/kino.log` and `kino.error.log`.
- Health: `curl -s localhost:1234/health`. Cast and DLNA devices: `curl -s localhost:1234/api/cast/devices`.
- Older Chromecasts play H.264 + AAC only, no HEVC, MPEG-TS HLS. Everything in `server/media/decide.ts` and `server/score.ts` about `target === 'chromecast'` exists because of them.
- DLNA TVs (LG webOS and others) are found over SSDP only while they are awake. They pull the raw file and decode MKV, HEVC and 5.1 themselves.
- The player is one screen for both places a film plays: `LocalPlayer` here, `TvRemote` (`tv=true` in the play link) as the TV's remote with the same look. Casting from the player stays on that route in TV mode; "This iPhone" in the Play on list (`PlayOn.tsx`) takes it back from where the TV is. The mini bar and a Kino tile in the Cast Center open TV mode (`nowPlayingParams` in `client/lib/handoff.ts`); other apps keep the Cast Center controller.
- Nest speakers are audio-only (`audioOnly`). Kino's controls hide them: the Cast Center, the now-playing bar and the palette show TVs only (`tvsOnly` in `client/lib/tvs.ts`), `CastPicker` keeps them behind a "show speakers" toggle, and the one-tap "On TV" on a title counts TVs only.
- Remote access: `tailscale serve` in front of :1234, no auth unless `KINO_PIN` is set. Never write a tailnet hostname into the repo.

## Safe on a Mac that runs Kino

- **`make deploy-safe` is the default deploy.** It waits until `/health` has been idle for 5 minutes, builds committed HEAD in a throwaway worktree, copies `dist/` over and restarts. Run it in the background.
- `make deploy-local` builds and restarts now. It refuses while someone is watching unless `FORCE=1`. A restart drops every HLS session, open stream and cast or DLNA session.
- Before any restart, check `curl -s localhost:1234/health`: `busy` must be false (it covers casts, transcoders and viewer streams). `scripts/health-state.sh` prints busy, idle or down.
- deploy-safe and deploy-local keep the previous build in `dist.prev/`. `make rollback-local` swaps it back and restarts (refuses while someone is watching unless `FORCE=1`); run it again to go forward.
- **`bun run build` / `make build` in the checkout launchd serves ships to production:** it writes the `dist/` production serves from disk, so every open browser gets the new client against the old server. To check that it builds, run `bun run build:check` (temp dirs, `dist/` untouched). Build a real `dist/` for smoke tests only inside a git worktree.
- **Never `bun run dev` there.** Production holds :1234, so the dev API retries, then idles, and vite on :5173 proxies to production and its data. Use `bun run dev:iso`.
- Smoke server (from a worktree build): `PORT=1299 KINO_DATA=$(mktemp -d) KINO_HOSTNAME=off KINO_PLAIN_PORT=0 node dist/server/index.js`.
- Stop a smoke server by its PID (`kill $PID`), never with `pkill -f` on a pattern like `dist/server/index.js`: that also matches production, and a clean exit is not restarted by launchd.
- Parallel agent sessions share the checkout. Check `git status` first, stage explicit paths, never `git add -A`.
- After a macOS update, `make` (and `/usr/bin/git`, `/usr/bin/python3`) may refuse with "You have not agreed to the Xcode license agreements" until the owner runs `sudo xcodebuild -license`. `scripts/deploy-safe.sh` runs directly as a fallback (it needs Homebrew's git and python3 first on `PATH`).
- ffmpeg and ffprobe: the server runs the first that works of `FFMPEG_BIN`/`FFPROBE_BIN`, the `ffmpeg-static`/`ffprobe-static` binary, `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, then `PATH` (`server/media/bins.ts`). ffprobe-static's arm64 build is really x86_64, so without Rosetta an Apple Silicon Mac uses Homebrew's; `/health` reports `ffprobe`/`ffmpeg` (runs or not) and the paths.

## Commands

```sh
bun run dev:iso    # dev next to a running Kino: tsx watch API on :1299 with ~/kino-dev data + vite on :5174
bun run dev:desktop # dev:iso plus the Electron window on :5174 (API :1299, ~/kino-dev): never touches production
bun run desktop    # worktree only: build, then the Electron app, its server on :1299 with a temp data folder. desktop:dist needs a real bun install there
bun run dev        # tsx watch API on :1234 + vite on :5173 (proxies /api). Never where Kino already runs
bun run test       # node:test via tsx, test/**/*.test.ts
bun run typecheck  # tsc --noEmit: server, client, then test/ + vite.config.ts
bun run knip       # unused files, exports and dependencies (knip.json; bunx, nothing installed)
bun run build:check # server tsc + vite build into temp dirs, prints the entry chunk size, fails if sw.js pre-caches a file the build lacks: the routine build check
bun run build      # dist/server + dist/client. Where launchd serves the checkout, this ships to production
make status-local  # launchd state + health json
make logs-local    # tail the log
```

Single test file: `node --test --import tsx --import ./test/setup.ts test/score.test.ts` (the setup gives each run a temp `KINO_DATA`).

`KINO_API_PORT` (default 1234) is the API vite proxies `/api` and `/health` to. `dev:iso` sets it to 1299; `KINO_DEV_DATA` overrides its data folder (a `mktemp -d` for a throwaway run). Check isolation with `curl -s localhost:5174/health`: `dataDir` must not be `~/kino-data`.

Dev and worktree desktop windows use their own Electron app folder, never Kino.app's (its single-instance lock would quit them): `Kino Dev` under `~/Library/Application Support` for `dev:desktop`, a throwaway `KINO_USER_DATA` for a worktree `bun run desktop` (`desktop/main.cjs`, `scripts/desktop.sh`).

## Architecture in one breath

`server/index.ts` boots store, torrent client, Cast and DLNA discovery, HLS reaper and Express. Middleware in order: `refuseWhileStopping` (`lifecycle.ts`, 503 once shutdown began), `hostGuard` (`host.ts`, 421 for any Host but IPs, localhost, `.local`, `.ts.net`, this machine's name and `KINO_HOSTS`), the cross-site write check on `/api` (`csrf.ts`, 403), `express.json` (application/json only), `GET /health` (`isBusy` from `health.ts`; without the PIN cookie only ok, version, uptime, busy), then with `KINO_PIN` set `POST /api/auth` and the PIN gate (`pin.ts`: cookie token, wrong-PIN pauses, `pinOpen` keeps media GET/HEAD open for TVs), the `/api` router, `jsonErrors` (`errors.ts`), the static client. `lifecycle.ts` also kills orphaned transcoders at boot and runs the shutdown sequence.

`routes/` is the whole HTTP API: `index.ts` mounts one router per part (`browse`, `library`, `play`, `subs`, `cast`, `settings`) in order, shared checks in `util.ts`; `home.ts` assembles `/home`, `settings.ts` checks settings writes and restored backups. `addons.ts` fans out to Stremio addons, `parse.ts` turns release names into `Source`s, `score.ts` ranks them per target, `scrape.ts` counts live seeders. `meta.ts` (Cinemeta), `discover.ts`, `taste.ts` (watch history as numbers) and `tmdb.ts` (optional key) build the Home and Browse rails; `ratings.ts` scans IMDb dumps; `upcoming.ts` is Coming up. `torrent.ts` wraps one webtorrent client, one file at a time, refcounts, LRU-evicts; `downloads.ts` holds files for play later. `media/`: `bins` picks the ffmpeg and ffprobe that run, `probe` (ffprobe) feeds `decide` (direct | hls-copy | hls-transcode), `hls` runs ffmpeg sessions, `intro` and `credits` estimate skip-intro and credits points. `cast/`: castv2 sessions with bonjour + dns-sd discovery, `timeout.ts` bounds every Chromecast request, `dlna.ts` drives UPnP renderers, `monitor.ts` keeps live state per Cast device, `upnext.ts` runs the up-next popup on either transport. `subs/` normalises everything to WebVTT, `ids.ts` signs subtitle ids with `secret.key`, `sync.ts` aligns cues to speech. `store.ts` is one JSON file with atomic writes and versioned migrations. Client is hash-routed React with a module store and `useSyncExternalStore`, no UI library, hand-written CSS in `client/styles/`; `client/lib/` holds the shared pieces (`urls` route builders without DOM, `episodes`, `tvs`, `keys` for g chords, `cast-actions` for send to TV and play here). Full map: README "Repo layout".

## Invariants that bite

- **Casting is server-side on purpose.** iPhone Safari has no Cast SDK. Do not move casting into the browser.
- **Native process, not Docker.** Docker on macOS cannot do mDNS multicast or SSDP, so Cast and DLNA discovery would break.
- **`/api/file/:hash/:idx` must stay range-capable with CORS `*`.** Browsers, the Chromecast, DLNA TVs and ffmpeg's http demuxer all seek through it.
- **Only the selected file is downloaded.** `torrent.ts` uses `deselect: true` then selects one file. A "download the whole torrent" shortcut will blow the 10 GB cache.
- **Subtitles are JS-managed cues, not a `<track>` element.** A `<track>` reloads the video and fights hls.js. See `client/lib/vtt.ts` and the Player.
- **hls.js in Chrome/Firefox, native HLS only on Safari/iOS.** `client/lib/hls-attach.ts` decides (lazy-loads hls.js, native when Safari/iOS can play HLS) using the detection in `client/lib/player-caps.ts`. Chrome has no native HLS.
- **One launchd plist, one label `com.kino`.** `launchd/com.kino.plist.template` is rendered with real paths by `scripts/plist.sh` (for `scripts/install.sh` and `make install-local`) into `~/Library/LaunchAgents/com.kino.plist`.
- **`ffmpeg-static` downloads a platform binary at `bun install`.** Always install on the machine that runs Kino, never copy `node_modules` from another one. Bun skips lifecycle scripts unless the package is in `trustedDependencies` in `package.json`, so a new native dependency has to be added there or its binary never arrives.
- **dns-sd discovery exists because bonjour-service gets nothing on a Mac where Home Assistant already owns udp/5353.** Keep both paths, merged, on darwin.
- **Chromecast discovery accumulates.** A device that misses one browse window must not flicker out of the picker.
- **The desktop DMG bundles jellyfin-ffmpeg's GPL build** (`scripts/ffmpeg-dmg.sh`, licence and source link next to the binaries). Never ffmpeg-static's macOS build: it is configured with `--enable-nonfree` and not redistributable.

## Conventions

- TypeScript strict, ESM, Node 26 (pinned with bun in `mise.toml`). Dense code is fine; one-line handlers are normal here. Prefer a small pure function plus a test in `test/` over a comment.
- Any pure data-in, data-out module gets a test in `test/`. Tests are `node:test` with `assert/strict`.
- `test/<module>.test.ts` per module; temp dirs removed in `after()`; tests never read or write `~/kino-data` (`bun run test` preloads `test/setup.ts` for a temp `KINO_DATA`; add `--import ./test/setup.ts` to a single-file run).
- User-facing copy: full words, no jargon in the UI, no em or en dashes anywhere (code, comments, commits, copy).
- Commit messages: `type(scope): summary` then a short body. Concise.
- When asking the owner to choose, put the recommended option first with "(Recommended)".
- Ask the owner before cutting a release (a `v*` tag builds and publishes the desktop app) or changing anything in the README's Legal section.
