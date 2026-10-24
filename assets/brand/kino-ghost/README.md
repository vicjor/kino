# Kino ghost asset pack

The selected lavender blanket ghost, with its raised eyebrow, remote and coral sock.
Prepared 2026-10-03. Open [preview.png](preview.png) for an overview.

## Start here

| Use | File |
| --- | --- |
| App header on Kino's dark background | [logos/kino-horizontal-on-dark-960.png](logos/kino-horizontal-on-dark-960.png) |
| Logo on a light background | [logos/kino-horizontal-on-light-960.png](logos/kino-horizontal-on-light-960.png) |
| Character without lettering | [marks/ghost-color-1024.png](marks/ghost-color-1024.png) |
| Main macOS app icon | [macos/Kino.icns](macos/Kino.icns) |
| Optional dark macOS icon | [macos/Kino-Dark.icns](macos/Kino-Dark.icns) |
| Browser favicon | [web/favicon.ico](web/favicon.ico) or [web/icon.svg](web/icon.svg) |
| iPhone home screen | [web/icon-180.png](web/icon-180.png) |
| PWA icon | [web/icon-192.png](web/icon-192.png), [web/icon-512.png](web/icon-512.png) |
| PWA maskable icon | [web/icon-maskable-512.png](web/icon-maskable-512.png) |
| Electron menu bar | [macos/tray/trayTemplate.png](macos/tray/trayTemplate.png) and [macos/tray/trayTemplate@2x.png](macos/tray/trayTemplate@2x.png) |

Integrated into Kino's client headers, welcome and PIN screens, web/PWA icons, Electron
menu bar templates and macOS packaging. `client/components/Brand.tsx` uses the 480-pixel
dark-background wordmark through Vite, so the logo is fingerprinted and cached with the
app shell. The source checkout is updated; deployment is a separate step.

## Variants and sizes

- `sources/`: original approved concept and four transparent generated masters at their
  native 1254 x 1254 resolution. `prompts.json` records the built-in image generation prompts.
- `marks/`: full-color, black and white transparent character PNGs at 64, 128, 256, 512
  and 1024 pixels; lossless WebP at 256, 512 and 1024 pixels.
- `marks/ghost-small-*`: close-up hood, face and collar at 16, 24, 32, 48, 64, 128, 256
  and 512 pixels. Intended for tiny spaces; the full character remains the primary identity.
- `logos/`: horizontal transparent logos at 480 x 150, 960 x 300 and 1920 x 600, in PNG
  and lossless WebP. Stacked PNG logos at 256, 512 and 1024 pixels square.
  Each layout has color for light backgrounds, color for dark backgrounds, black and white.
- `macos/`: light and dark `.icns` files, their complete `.iconset` directories, and PNG
  exports at 16, 32, 64, 128, 256, 512 and 1024 pixels. The iconsets use the close-up for
  16-point and 32-point slots, including their Retina equivalents; larger slots use the full ghost.
- `macos/tray/`: black artwork with alpha at 18/36 and 22/44 pixels. The standard pair
  matches the filenames that Kino's Electron code already reads. macOS supplies template tint.
- `macos/layers/`: unmasked 1024-pixel light/dark backgrounds and a transparent foreground
  for future import into Apple's Icon Composer. These are source layers, not a compiled `.icon` asset.
- `web/`: opaque square icons at 16, 24, 32, 48, 64, 128, 180, 192, 256, 512 and
  1024 pixels. Smaller icons use the portrait. Separate 192/512-pixel maskable icons keep all
  character artwork inside the central safe circle. The ICO contains seven sizes from 16 to 256.
- `palette.json`: recommended colors for backgrounds and accompanying UI.
- `files.json`: dimensions, transparency metadata and byte counts for every raster export.

`on-light` means dark lettering for a light background. `on-dark` means cream lettering
for a dark background. All logo files are transparent, so the destination provides the background.
Black and white marks retain facial and blanket details as negative space.

## Using the files in Kino

### Client logo

Copy the preferred mark or logo into `client/public/brand/`. For the existing dark UI,
use `kino-horizontal-on-dark-960.webp` or its PNG equivalent. For example:

```tsx
<a href="#/" aria-label="Kino home">
  <img src="/brand/kino-horizontal-on-dark-960.webp" alt="Kino" width={160} height={50} />
</a>
```

Use the full character at about 48 CSS pixels or larger. At smaller sizes, choose the
close-up portrait. Do not recolor the colored ghost or remove its eyebrow. Allow clear space
around the silhouette and avoid stretching. The light and dark logo variants handle contrast.

### Web and PWA icons

The `web/` filenames match Kino's existing `client/public/` references. When integrating,
replace `icon.svg`, `icon-180.png`, `icon-192.png`, `icon-512.png` and
`icon-maskable-512.png` together. The optional ICO can be linked from `client/index.html`.
`manifest-icons.json` is an icon-array example, not a replacement for Kino's whole manifest.
Update the service worker cache version when shipping replaced assets.

### Electron app icon

Copy `macos/Kino.icns` to `desktop/Kino.icns`, then set `build.mac.icon` in `package.json`
to `desktop/Kino.icns`. Keep the Linux icon as a PNG. Use the light icon by default;
the dark variant is an alternative rather than an automatic system appearance switch.

For the menu bar, copy the standard `trayTemplate.png` and `trayTemplate@2x.png` pair
to `desktop/`. The current Electron code already sets the image as a template.

Build and deploy only through the repository's safe workflows. Creating a DMG is not part
of this asset pack, and its existing distribution restrictions still apply.

## Source format and regeneration

The character is raster artwork, not editable vector paths. `web/icon.svg` is a self-contained
SVG wrapper around a PNG for compatibility with Kino's existing favicon URL. It is not a
vector master. The largest transparent character export is 1024 pixels, below the master resolution.
The 1920-pixel logos lay out the character alongside separately rendered typography.

`export.cjs` produces all sizes deterministically from the approved sources using Sharp.
No AI calls are made by the script. It does not write to `dist/`, `client/public/` or `desktop/`.
The wordmark font is supplied by the host, not redistributed in this pack.

```sh
NODE_PATH=/path/to/node_modules node assets/brand/kino-ghost/export.cjs
iconutil -c icns assets/brand/kino-ghost/macos/Kino.iconset -o assets/brand/kino-ghost/macos/Kino.icns
iconutil -c icns assets/brand/kino-ghost/macos/Kino-Dark.iconset -o assets/brand/kino-ghost/macos/Kino-Dark.icns
```

Sharp must be installed in the supplied `node_modules`. On macOS the exporter uses the
installed Arial Rounded Bold font; set `KINO_BRAND_FONT` to another font file if necessary.
The exporter uses a temporary font cache and removes it after completion.
`--icns` runs both macOS compilation commands as part of the export when permitted.

Packaging follows Apple's [iconset size conventions](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html)
and includes separate foreground/background sources for the current [app icon workflow](https://developer.apple.com/design/human-interface-guidelines/app-icons/).
