import type Hls from 'hls.js';
import { isIOS, isSafari, canPlayNativeHls } from './player-caps';
import { MEDIA, type Words } from './play-errors';

interface FailInfo { hint?: string; detail?: string; retry?: boolean }
type OnFail = (msg: string, info: FailInfo) => void;
/** Report a failure in the words from play-errors.ts. */
const failWith = (onFail: OnFail, w: Words, detail: string | undefined, retry: boolean) => onFail(w.msg, { hint: w.hint, detail, retry });

/** hls.js is most of the bundle and Safari/iOS never needs it, so it arrives on first use. */
let hlsMod: Promise<typeof Hls> | null = null;
const loadHls = () => (hlsMod ??= import('hls.js').then((m) => m.default).catch((e) => { hlsMod = null; throw e; }));
const wantsNative = () => (isSafari || isIOS) && canPlayNativeHls();
/** Start fetching hls.js early (player mount) so it is ready by the time the stream is. No-op on Safari/iOS. */
export function preloadHls(): void { if (!wantsNative()) void loadHls().catch(() => undefined); }

/**
 * One attachment of a URL to a <video>. destroy() before the next attach, at any point: it stops hls.js, or drops
 * the pending ready callback when the element plays the URL itself. `hls` is the hls.js instance once the library
 * has loaded, and stays null when the element plays it.
 */
export interface Attached { destroy(): void; readonly hls: Hls | null }

/**
 * Point a <video> at a URL: the element itself for direct files and for native HLS on
 * Safari/iOS, hls.js everywhere else (Chrome has no native HLS).
 */
export function attachMedia(v: HTMLVideoElement, url: string, o: { native: boolean; onReady: () => void; onFail: OnFail }): Attached {
  let dead = false;
  let inst: Hls | null = null;
  // A re-attach before the metadata arrived must not fire this attach's onReady on the next source.
  const ready = () => { if (!dead) o.onReady(); };
  const native = () => { v.src = url; v.addEventListener('loadedmetadata', ready, { once: true }); v.load(); return null; };
  const attached: Attached = { destroy() { dead = true; v.removeEventListener('loadedmetadata', ready); inst?.destroy(); inst = null; }, get hls() { return inst; } };
  if (o.native || wantsNative()) { native(); return attached; }
  loadHls().then((H) => { if (!dead) inst = withHls(H, v, url, o, native); }, (e: Error) => { if (!dead) failWith(o.onFail, MEDIA.loader, e.message, true); });
  return attached;
}

function withHls(Hls: typeof import('hls.js').default, v: HTMLVideoElement, url: string, o: Parameters<typeof attachMedia>[2], native: () => null): Hls | null {
  if (Hls.isSupported()) {
    // hls.js is far more reliable than native HLS in Chrome/Firefox.
    const h = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 90, maxBufferLength: 60, renderTextTracksNatively: false });
    h.on(Hls.Events.MANIFEST_PARSED, o.onReady);
    // Retry a few times, then say what broke instead of looping forever on a dead session.
    let netFails = 0, mediaFails = 0;
    h.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      const code = data.response?.code;
      const gone = code === 404 || code === 410;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (gone || ++netFails > 3) {
          failWith(o.onFail, gone ? MEDIA.gone : MEDIA.lost, `${data.details}${code ? ` (HTTP ${code})` : ''}`, true);
          return;
        }
        h.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (++mediaFails > 2) { failWith(o.onFail, MEDIA.broken, data.details, false); return; }
        h.recoverMediaError();
      } else failWith(o.onFail, MEDIA.other, data.details, true);
    });
    h.loadSource(url);
    h.attachMedia(v);
    return h;
  }
  if (canPlayNativeHls()) return native();
  o.onFail(MEDIA.browser.msg, { hint: MEDIA.browser.hint });
  return null;
}
