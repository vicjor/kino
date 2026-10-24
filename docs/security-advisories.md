# Security advisories

Every advisory `bun audit` reports for `bun.lock`, with whether Kino can reach it and what was decided. Reviewed 2026-10-01 with bun 1.4.2.

`scripts/audit-gate.ts` runs `bun audit --json` in CI and fails on any advisory without a row here whose Decision starts with **Accepted**. A row marked Fixed that bun reports again fails too. One row per package and advisory: `bun audit` counts an advisory once per vulnerable range, so its total is higher (24 before the build-only fixes below, 14 after).

## Reviewing a new one

1. `bun audit` prints the dependency path; `bun why <package>` shows who pulls it in.
2. If an in-range version fixes it, `bun audit fix --lockfile-only` changes `bun.lock` and nothing else. Never run `bun audit fix` without `--lockfile-only` in the main checkout: its `node_modules` is what production runs.
3. Otherwise read the advisory's preconditions against how Kino uses the package and add a row: **Accepted** with the reason, or fix it (override, replace the dependency).
4. `node scripts/audit-gate.ts` passes again.

## Runtime (ships in the server)

| Package | Advisory | Severity | Path | Reachable in Kino | Decision |
|---|---|---|---|---|---|
| `protobufjs` 6.11.6 | [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg): code execution from a crafted schema or JSON descriptor | critical | `castv2-client > castv2 > protobufjs` | No. castv2 loads only the `cast_channel.proto` it ships; no schema or descriptor ever comes from a device, an addon or a user. | **Accepted**: trusted schema only. Fix with protobufjs 7 (follow-ups). |
| `protobufjs` 6.11.6 | [GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm): code injection through `bytes` defaults in generated `toObject` | high | `castv2-client > castv2 > protobufjs` | No. Needs an attacker's schema, and castv2 never calls `toObject`. | **Accepted**: trusted schema only. |
| `protobufjs` 6.11.6 | [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7): code generation gadget after prototype pollution | high | `castv2-client > castv2 > protobufjs` | No. Needs a separate way to pollute `Object.prototype` first; none is known in Kino (request bodies go through `JSON.parse`, which cannot). | **Accepted**: no pollution primitive. |
| `protobufjs` 6.11.6 | [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg): process-wide denial of service through unsafe option paths in a schema | high | `castv2-client > castv2 > protobufjs` | No. Needs an attacker's schema. | **Accepted**: trusted schema only. |
| `protobufjs` 6.11.6 | [GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q): denial of service through unbounded recursion while decoding nested binary | high | `castv2-client > castv2 > protobufjs` | **Yes, from the LAN.** `cast/monitor.ts` keeps a connection to every device that advertises Cast over mDNS and decodes what it sends, so a hostile device on the home network can send deeply nested unknown groups and overflow the stack. The `uncaughtException` handler in `server/index.ts` logs the RangeError and the process stays up: that device's own connection fails and reconnects. No code execution. | **Accepted**: LAN only, contained to the sending device. Fix with protobufjs 7 (follow-ups). |
| `protobufjs` 6.11.6 | [GHSA-wcpc-wj8m-hjx6](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6): denial of service through nested `Any` expansion during JSON conversion | high | `castv2-client > castv2 > protobufjs` | No. `cast_channel.proto` has no `google.protobuf.Any`, and castv2 never converts messages to JSON. | **Accepted**: schema has no `Any`. |
| `protobufjs` 6.11.6 | [GHSA-2pr8-phx7-x9h3](https://github.com/advisories/GHSA-2pr8-phx7-x9h3): denial of service from crafted field names in a schema | moderate | `castv2-client > castv2 > protobufjs` | No. Needs an attacker's schema. | **Accepted**: trusted schema only. |
| `protobufjs` 6.11.6 | [GHSA-fx83-v9x8-x52w](https://github.com/advisories/GHSA-fx83-v9x8-x52w): prototype injection in generated message constructors | moderate | `castv2-client > castv2 > protobufjs` | No. castv2 builds every object it encodes itself (ids, namespace, a JSON string payload); no outside keys reach a constructor. | **Accepted**: no outside objects. |
| `protobufjs` 6.11.6 | [GHSA-q6x5-8v7m-xcrf](https://github.com/advisories/GHSA-q6x5-8v7m-xcrf): overlong UTF-8 decoding | moderate | `castv2-client > castv2 > protobufjs` | No. castv2 decodes Buffers, and protobufjs reads their strings with Node's native `utf8Slice`, not the affected fallback decoder. Kino does no byte-level filtering before decoding either. | **Accepted**: native decoder on Node. |
| `protobufjs` 6.11.6 | [GHSA-jggg-4jg4-v7c6](https://github.com/advisories/GHSA-jggg-4jg4-v7c6): denial of service through recursive JSON descriptor expansion | moderate | `castv2-client > castv2 > protobufjs` | No. No JSON descriptor is loaded: castv2 parses its own `.proto` file. | **Accepted**: no descriptors loaded. |
| `protobufjs` 6.11.6 | [GHSA-f38q-mgvj-vph7](https://github.com/advisories/GHSA-f38q-mgvj-vph7): schema names that shadow runtime properties | moderate | `castv2-client > castv2 > protobufjs` | No. `cast_channel.proto` has no field named `hasOwnProperty` or `$type` and no service. | **Accepted**: no affected names. |
| `ip` 2.0.1 | [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp): `isPublic` calls some private addresses public (SSRF) | high | `bittorrent-tracker > ip`, `webtorrent > torrent-discovery > bittorrent-tracker > ip` | No. Only bittorrent-tracker's tracker server (`lib/server/parse-udp.js`, which calls `ip.toString`) imports it. Kino runs the tracker client (`scrape.ts`, webtorrent), and nothing calls `isPublic`. Kino's own address checks (`net-guard.ts`) do not use it. | **Accepted**: no fixed version exists (the package is abandoned). Goes away when bittorrent-tracker drops it. |
| `ip-address` 10.7.0 | [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv): `isInSubnet` compares IPv4 addresses with IPv6 networks | moderate | `bittorrent-tracker > socks > ip-address`, `webtorrent > load-ip-set > ip-set > ip-address` | No. socks parses addresses only when a SOCKS proxy is set, ip-set only for a webtorrent `blocklist`; Kino sets neither. | **Accepted**: code path never runs. 10.7.1 fixes it in range, left for the next routine runtime update. |
| `ip-address` 10.7.0 | [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw): parsing a long string as IPv6 can stall or crash the process | moderate | `bittorrent-tracker > socks > ip-address`, `webtorrent > load-ip-set > ip-set > ip-address` | No. Same two code paths as above, and neither runs. | **Accepted**: code path never runs. 10.7.1 fixes it in range, left for the next routine runtime update. |

## Build only (electron-builder, DMG packaging)

These run only when the desktop DMG is packaged on the owner's Mac, on patterns and config from this repo's `package.json`. Nothing here is in the server or the client.

| Package | Advisory | Severity | Path | Reachable in Kino | Decision |
|---|---|---|---|---|---|
| `brace-expansion` 1.1.18, 2.1.4, 5.0.9 | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7): denial of service through recursion on nested brace groups | high | `electron-builder > app-builder-lib > minimatch > brace-expansion`, plus the minimatch copies under `@electron/asar`, `@electron/universal`, `dir-compare`, `filelist`, `glob` | No. Only electron-builder's file globs, from `package.json`. | **Fixed**: lockfile bump to 1.1.21, 2.1.7, 5.0.12 (2026-10-01). |
| `brace-expansion` 1.1.18, 2.1.4, 5.0.9 | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p): denial of service through recursion in `parseCommaParts` | high | as above | No. Same. | **Fixed**: same bump. |
| `brace-expansion` 1.1.18, 2.1.4, 5.0.9 | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr): quadratic-time expansion of `{a},b}` | moderate | as above | No. Same. | **Fixed**: same bump. |
| `fast-uri` 3.1.7 | [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj): inconsistent host case normalization | moderate | `electron-builder > app-builder-lib > ajv > fast-uri` | No. ajv only validates electron-builder's own config. | **Fixed**: lockfile bump to 3.1.8 (2026-10-01). |

## Follow-ups

- **protobufjs 7 for castv2.** castv2 0.1.10 pins `protobufjs ^6.8.8`, so every protobufjs row needs a major bump that only an `overrides` entry can force. castv2 uses only `load`, `lookupType`, `encode` and `decode`, which 7.x keeps. Override to `^7.6.3`, then cast to the Living Chromecast and a Nest speaker before shipping. Clears all eleven protobufjs rows.
- **ip-address 10.7.1** is inside socks' and ip-set's ranges: `bun audit fix --lockfile-only` takes it with the next runtime dependency update.
- **ip** has no fixed release. Nothing to do while Kino never runs bittorrent-tracker's server.
