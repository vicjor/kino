# Changelog

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
