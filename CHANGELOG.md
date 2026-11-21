# Changelog

## 0.1.3 (2026-11-21)

- The Mac app is signed with a Developer ID and notarized by Apple, so it opens like any other app, with no trip to Privacy & Security. On first launch macOS asks once for Local Network access, which Kino needs to find the TVs.
- The Mac download is about a quarter smaller (LZMA disk image, English-only Electron resources).
- The Mac stays awake while someone watches and for an hour after. On battery it used to sleep minutes into a pause, and the TV app quit.
- A paused cast resumes instead of failing on every source. A stream the TV refuses is retried in a safer format instead of stopping silently, and 5.1 audio on older Chromecasts is converted to stereo.
- The episode you just paused is never the first to leave the cache, so a resume no longer starts over from peers.
- TV auto-next keeps the same release pack or group when it can, like the browser.
- A file the browser cannot play falls back to a conversion once. VP9 plays without converting in browsers that support it.
- The player says when Kino is out of reach instead of offering another source. Its stall question closes by itself once playback comes back.
- On phones the player's top bar fits and the subtitle sync row stays on one line.
- DLNA TVs are remembered across restarts (forgotten after 60 days unseen), checked less often while nobody watches, and a subtitle the TV refuses goes back to the previous one.
- Auto no longer picks a source when every source scores badly.
- Clearer words: time units spelled out, "downloaded" instead of "cached".
- `POST /api/cast/stop-all` only: a Home Assistant button or Shortcut that used GET needs to switch to POST.
- Running from source: `scripts/install.sh` offers to install a missing Node or bun with Homebrew.
- Dependency updates, including Vite 8, TypeScript 7 and protobufjs 7 for casting.

## 0.1.2 (2026-11-05)

- On a Mac that also runs Kino as a background service, the desktop app waits for that server at login instead of starting a second one. Two Kinos on one port could fail to play ("Could not fetch this file") and showed the welcome tour again.
- A second Kino started on a port already in use now stays idle, as intended, instead of loading its data and starting downloads.

## 0.1.1 (2026-10-24)

- The desktop app updates itself: it checks for new releases, offers them and installs on a restart. Check for Updates is in the Kino menu. From 0.1.0, download this version by hand once.
- Cmd+, opens Settings in the desktop app.
- The macOS app is for Apple Silicon only. Intel Macs can still run the server from a checkout.
- The macOS app is ad-hoc signed, so a downloaded DMG no longer opens as "damaged".

## 0.1.0 (2026-10-24)

First public release.

- Browse catalogs with Home rails that say why they are there, search, a command palette, title pages with ratings and per-episode progress.
- Plays on any browser and on iPhone, converting on the fly when a device cannot play a file as it is. Hardware encoding on Apple Silicon.
- Casting from the server to Chromecast and DLNA TVs, with a Cast Center for every TV and speaker on the network.
- Subtitles from subtitle addons, embedded tracks and files in the torrent, with sync and size controls.
- Desktop app for macOS (Apple Silicon and Intel) and an AppImage for Linux. Not signed: see the README for the first open.
