# Contributing

Kino is a personal project, shared as is. Bug reports and small, focused pull requests are welcome; for anything bigger, open an issue first so we can agree on the shape.

**Keep it a media player.** Do not name, link to or ask about torrent sites, indexers, stream addons or any other source of content, in code, tests, docs, screenshots, issues, pull requests or commit messages. Test fixtures use made-up release names and `example.com` addresses. Issues and pull requests that do will be closed. Screenshots show only openly licensed or public domain films as watched.

## Setup

```sh
bun install
bun run dev:iso      # :1299 API with its own data in ~/kino-dev + :5174 client
bun run dev          # :1234 API + :5173 client
bun run dev:desktop  # dev:iso (:1299 API, ~/kino-dev, :5174 client) in the Electron window
```

On a Mac that already runs Kino (launchd, the desktop app) `bun run dev` cannot bind :1234: its API idles and the vite client quietly talks to the running install and its data. Use `bun run dev:iso` there. `KINO_DEV_DATA=$(mktemp -d) bun run dev:iso` starts from an empty library.

Node 26 and bun, both pinned in `mise.toml`. `ffmpeg-static` and `ffprobe-static` download platform binaries during install, so a fresh `bun install` needs network.

## Before you push

```sh
bun run typecheck
bun run test
bun run build:check
bun run knip
```

`build:check` compiles the server and builds the client into temp dirs, so `dist/` is never touched, then runs `scripts/verify-build.ts` (entry chunk size, every file `sw.js` pre-caches is in the build). On the Mac that runs Kino, `bun run build` in the main checkout ships to production: the live server serves that `dist/` from disk. `knip` finds unused files, exports and dependencies; its version is pinned in `package.json` so a knip release cannot turn CI red on its own. CI (`.github/workflows/ci.yml`) runs typecheck, test, `build:check`, knip and `bun run audit:gate` on every push and pull request.

`audit:gate` (`scripts/audit-gate.ts`) runs `bun audit` and fails only on advisories that have no Accepted row in [docs/security-advisories.md](docs/security-advisories.md). When it fails, fix the advisory or review it there; that file says how.

## Conventions

- **Package-by-feature.** `server/media`, `server/cast`, `server/subs` own their domain end to end. New features go in a new folder, not into a shared `utils`.
- **Pure functions get tests.** Parsing, scoring, the direct/HLS decision, subtitle conversion. If it takes data in and returns data out, put a case in `test/`.
- **Test layout.** `test/<module>.test.ts` per module; temp dirs removed in `after()`; tests never read or write `~/kino-data`. `bun run test` preloads `test/setup.ts`, which points `KINO_DATA` at a temp dir. One file: `node --test --import tsx --import ./test/setup.ts test/score.test.ts`.
- **No UI library, no CSS framework.** Hand-written CSS in `client/styles/`, custom properties from `global.css`.
- **User-facing copy** uses full words. "Subtitles", not "subs". No em dashes anywhere in the repo, including comments and commit messages.
- **Commit messages**: `type(scope): summary`, then a body that says why. `feat(cast): ...`, `fix(hls): ...`, `docs: ...`.
- **Ask before changing defaults** for addons, cache size, or anything in the Legal section of the README. Kino bundles and recommends metadata and subtitle addons only, never stream addons.

## Testing on real devices

Unit tests cover the logic. Playback has to be tried on the actual targets, because they disagree:

| Target | What usually breaks |
|---|---|
| Chrome / Firefox desktop | hls.js edge cases, keyboard shortcuts |
| iPhone Safari (PWA) | native HLS, `playsinline`, MKV needs remux, lock-screen controls |
| Old Chromecast | HEVC needs transcode, MPEG-TS not fMP4, subtitle tracks, auto-next |

`bun run dev:iso`, then open `http://<this Mac's LAN address>:5174` on the phone. The dev API logs in the same terminal and discovers the same Chromecasts and TVs as an installed Kino. If you run Kino at home from this checkout, do not test with `make deploy-local`: a restart drops whatever the house is watching. Once it works and is committed, `make deploy-safe` ships it.
