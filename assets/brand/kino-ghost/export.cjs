// Rebuild the asset pack from approved PNG masters. Requires sharp; --icns also requires macOS iconutil.
// Set NODE_PATH to your installed sharp directory and KINO_BRAND_FONT to override the font.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = __dirname;
const palette = { cream: '#fff8ec', ink: '#29132f', lavender: '#c7a5e8', coral: '#ff795e', amber: '#f7b52b', dark: '#282032' };
const font = process.env.KINO_BRAND_FONT || '/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf';
// Keep font discovery and caches in a temporary directory, not the user's home.
const fontTemp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'kino-brand-fonts-'));
fsSync.mkdirSync(path.join(fontTemp, 'fonts'));
fsSync.mkdirSync(path.join(fontTemp, 'cache'));
fsSync.symlinkSync(font, path.join(fontTemp, 'fonts', 'wordmark.ttf'));
const previewFont = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (fsSync.existsSync(previewFont)) fsSync.symlinkSync(previewFont, path.join(fontTemp, 'fonts', 'preview.ttf'));
fsSync.writeFileSync(path.join(fontTemp, 'fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${fontTemp}/fonts</dir><cachedir>${fontTemp}/cache</cachedir></fontconfig>`);
process.env.FONTCONFIG_FILE = path.join(fontTemp, 'fonts.conf');
const sharp = require('sharp');
const manifest = [];
const b64 = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const img = (buffer, x, y, w, h) => `<image href="${b64(buffer)}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
const square = (size, background = { r: 0, g: 0, b: 0, alpha: 0 }) => sharp({ create: { width: size, height: size, channels: 4, background } });
async function save(name, buffer, kind) {
  const dest = path.join(root, name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buffer);
  const meta = await sharp(buffer).metadata();
  manifest.push({ file: name, width: meta.width, height: meta.height, alpha: meta.hasAlpha, kind, bytes: buffer.length });
}
async function write(name, content) {
  const dest = path.join(root, name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content);
}
async function readMaster(name) {
  const source = await fs.readFile(path.join(root, 'sources', `${name}.png`));
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = 0, maxY = 0, clear = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const a = data[(y * info.width + x) * 4 + 3];
    if (!a) clear++;
    if (a > 8) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  assert(clear > info.width * info.height * 0.05, `${name} requires real transparency`);
  assert(data[3] === 0, `${name} has an opaque corner`);
  return sharp(source).extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }).png().toBuffer();
}
async function mark(source, size, fill = 0.94) {
  const inset = Math.round(size * fill);
  const p = await sharp(source).resize(inset, inset, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
  return square(size).composite([{ input: p, gravity: 'centre' }]).png().toBuffer();
}
async function ink(source, color) {
  const meta = await sharp(source).metadata();
  // The generated one-ink source supplies geometry; only ink color changes here.
  return sharp({ create: { width: meta.width, height: meta.height, channels: 4, background: color } })
    .composite([{ input: source, blend: 'dest-in' }]).png().toBuffer();
}
async function icon(source, size, background, mac = false) {
  const tile = mac ? '<rect x="64" y="64" width="896" height="896" rx="200"' : '<rect width="1024" height="1024"';
  const body = `${tile} fill="${background}"/>${img(source, 130, 130, 764, 764)}`;
  return sharp(svg(1024, 1024, body)).resize(size).png().toBuffer();
}
async function maskable(source, size) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let radius = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 8) radius = Math.max(radius, Math.hypot(x - (info.width - 1) / 2, y - (info.height - 1) / 2));
  }
  // All visible artwork fits a circle of radius 37.5%, inside the 40% safe zone.
  const scale = 1024 * 0.375 / radius, w = info.width * scale, h = info.height * scale;
  assert(radius * scale < 1024 * 0.4);
  return sharp(svg(1024, 1024, `<rect width="1024" height="1024" fill="${palette.cream}"/>${img(source, (1024-w)/2, (1024-h)/2, w, h)}`)).resize(size).png().toBuffer();
}
async function word(color) {
  return sharp({ text: { text: `<span foreground="${color}">Kino</span>`, font: 'Arial Rounded MT Bold 200', fontfile: font, rgba: true, dpi: 72 } }).png().toBuffer();
}
async function lockup(source, color, stacked = false) {
  const text = await word(color);
  if (stacked) return sharp(svg(1024, 1024, `${img(source, 222, 40, 580, 640)}${img(text, 230, 718, 564, 230)}`)).png().toBuffer();
  return sharp(svg(1920, 600, `${img(source, 30, 25, 550, 550)}${img(text, 680, 160, 1180, 300)}`)).png().toBuffer();
}
async function ico(images) {
  const chunks = [];
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (let i = 0; i < images.length; i++) {
    const { size, buffer } = images[i], p = 6 + i * 16;
    header[p] = size === 256 ? 0 : size; header[p + 1] = header[p];
    header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(buffer.length, p + 8); header.writeUInt32LE(offset, p + 12);
    chunks.push(buffer); offset += buffer.length;
  }
  return Buffer.concat([header, ...chunks]);
}
async function main() {
  const full = await readMaster('ghost-master'), small = await readMaster('ghost-small');
  const mono = await ink(await readMaster('ghost-mono'), '#000000');
  const white = await ink(mono, '#ffffff');
  const tray = await ink(await readMaster('ghost-tray'), '#000000');
  for (const [name, source] of [['color', full], ['black', mono], ['white', white]]) {
    for (const size of [64, 128, 256, 512, 1024]) {
      const output = await mark(source, size);
      await save(`marks/ghost-${name}-${size}.png`, output, 'transparent full character');
      if (size >= 256) await save(`marks/ghost-${name}-${size}.webp`, await sharp(output).webp({ lossless: true }).toBuffer(), 'transparent full character');
    }
  }
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) await save(`marks/ghost-small-${size}.png`, await mark(small, size), 'compact portrait');
  for (const [theme, source, color] of [['on-light', full, palette.ink], ['on-dark', full, palette.cream], ['black', mono, '#000000'], ['white', white, '#ffffff']]) {
    const horizontal = await lockup(source, color), stacked = await lockup(source, color, true);
    for (const width of [480, 960, 1920]) {
      const png = await sharp(horizontal).resize(width).png().toBuffer();
      await save(`logos/kino-horizontal-${theme}-${width}.png`, png, 'transparent logo');
      await save(`logos/kino-horizontal-${theme}-${width}.webp`, await sharp(png).webp({ lossless: true }).toBuffer(), 'transparent logo');
    }
    for (const size of [256, 512, 1024]) await save(`logos/kino-stacked-${theme}-${size}.png`, await sharp(stacked).resize(size).png().toBuffer(), 'transparent stacked logo');
  }
  for (const [theme, bg] of [['light', palette.cream], ['dark', palette.dark]]) {
    const iconset = `macos/Kino${theme === 'dark' ? '-Dark' : ''}.iconset`;
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) await save(`macos/png/kino-${theme}-${size}.png`, await icon(size <= 32 ? small : full, size, bg, true), 'macOS icon');
    for (const logical of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      await save(`${iconset}/icon_${logical}x${logical}${scale === 2 ? '@2x' : ''}.png`, await icon(logical <= 32 ? small : full, logical * scale, bg, true), 'macOS iconset');
    }
    if (process.argv.includes('--icns')) execFileSync('/usr/bin/iconutil', ['-c', 'icns', path.join(root, iconset), '-o', path.join(root, 'macos', `Kino${theme === 'dark' ? '-Dark' : ''}.icns`)]);
    await save(`macos/layers/background-${theme}-1024.png`, await square(1024, bg).png().toBuffer(), 'unmasked Icon Composer background');
  }
  await save('macos/layers/foreground-1024.png', await mark(full, 1024, 0.76), 'Icon Composer foreground');
  for (const [name, size] of [['trayTemplate', 18], ['trayTemplate@2x', 36], ['trayTemplate-22', 22], ['trayTemplate-22@2x', 44]]) await save(`macos/tray/${name}.png`, await mark(tray, size, 0.94), 'black alpha template');
  for (const size of [16, 24, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) await save(`web/icon-${size}.png`, await icon(size <= 48 ? small : full, size, palette.cream), 'opaque web icon');
  for (const size of [192, 512]) await save(`web/icon-maskable-${size}.png`, await maskable(full, size), 'opaque maskable icon');
  const faviconSource = await icon(small, 256, palette.cream);
  await write('web/icon.svg', svg(256, 256, img(faviconSource, 0, 0, 256, 256)));
  // This compatibility SVG embeds a PNG; it is not editable vector artwork.
  await write('web/favicon.ico', await ico(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async size => ({ size, buffer: await icon(small, size, palette.cream) })))));
  await write('web/manifest-icons.json', JSON.stringify({ icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] }, null, 2) + '\n');
  await write('palette.json', JSON.stringify(palette, null, 2) + '\n');
  await preview();
  await write('files.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Exported and dimension-checked ${manifest.length} raster files, both iconsets, favicon ICO and SVG.${process.argv.includes('--icns') ? ' Compiled both ICNS files.' : ''}`);
}
async function preview() {
  const file = (p) => fs.readFile(path.join(root, p));
  const items = [];
  items.push(img(await file('marks/ghost-color-512.png'), 80, 125, 400, 400));
  items.push(img(await file('logos/kino-horizontal-on-dark-960.png'), 630, 180, 840, 263));
  items.push(img(await file('macos/png/kino-light-256.png'), 70, 600, 220, 220));
  items.push(img(await file('macos/png/kino-dark-256.png'), 310, 600, 220, 220));
  for (const [i, size] of [16, 24, 32, 48, 64, 128].entries()) {
    items.push(img(await file(`marks/ghost-small-${size}.png`), 620 + i * 136 + (128 - size) / 2, 660 + (128 - size) / 2, size, size));
    items.push(`<text x="${684 + i * 136}" y="817" text-anchor="middle" font-size="18" fill="#83758b">${size}px</text>`);
  }
  items.push(img(await file('logos/kino-horizontal-black-960.png'), 80, 950, 600, 187.5));
  items.push(img(await file('logos/kino-horizontal-white-960.png'), 860, 950, 600, 187.5));
  const body = `<rect width="1600" height="1220" fill="#f4f0e8"/><rect x="560" y="100" width="980" height="420" rx="24" fill="${palette.dark}"/><rect x="800" y="920" width="740" height="250" rx="24" fill="${palette.dark}"/><g font-family="Arial,sans-serif"><text x="72" y="65" font-size="32" font-weight="700" fill="${palette.ink}">Kino / Ghost asset pack</text><text x="72" y="573" font-size="22" fill="${palette.ink}">macOS icons</text><text x="620" y="573" font-size="22" fill="${palette.ink}">Small-use portrait at actual pixel sizes</text><text x="72" y="900" font-size="22" fill="${palette.ink}">Single-ink logos</text>${items.join('')}</g>`;
  await save('preview.png', await sharp(svg(1600, 1220, body)).png().toBuffer(), 'overview');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rm(fontTemp, { recursive: true, force: true }));
