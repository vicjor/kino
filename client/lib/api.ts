import { setStore } from './store';
import { caps, decodeQuery } from './player-caps';
import type {
  HomeResponse, MetaPreview, Progress, StreamsResponse, PlayRequest, PlayResponse, TorrentStats,
  CastDevice, CastStatus, CastPlayRequest, Settings, AddonInfo, Target, ReceiverInfo, CastHistoryEntry, DownloadInfo, CatalogEntry, Ratings,
  BrowseResponse, BrowseGenres, BrowseType, PickOutcomeReport, MetaResponse, SimilarRail, SearchResponse, Followed, OkResponse, RestoreResult,
  Health, DiskReport, AddonRow, CastHandoff, ReceiverCommand, ReceiverCommandBody, VolumeRequest, IntroEstimate, CreditsEstimate, FileRef,
  IntroLearnRequest, BrowseQuery, HlsSeekResponse, TorrentAddResponse, SubsQuery, SubsResponse, SubSyncRequest, SubSyncResult, ProgressPatch,
  WatchlistAdd, FollowAdd, DownloadRequest,
} from '../../server/types.js';

class ApiError extends Error { constructor(public status: number, msg: string, public code?: string) { super(msg); } }
/** The server's `code` for what kind of failure this was (server ErrorCode), when it sent one. Words come from the client, never from its text. */
export const errorCode = (e: unknown): string | undefined => (e instanceof ApiError ? e.code : undefined);
/** The request never reached Kino (no connection, the Mac asleep or off): nothing about the source. */
export const isOffline = (e: unknown): boolean => e instanceof ApiError && e.status === 0;

/**
 * Last good answer per GET url, so a screen you have seen paints at once and a dropped request shows the old
 * data instead of an error. Bounded; the server stays the source of truth.
 */
const cache = new Map<string, unknown>();
const CACHE_MAX = 80;
function remember(url: string, v: unknown): void { if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string); cache.delete(url); cache.set(url, v); }
export function cached<T>(url: string): T | undefined { return cache.get(url) as T | undefined; }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Wait for the browser to come back online, briefly: a phone waking up, a Wi-Fi hand-over. */
function untilOnline(maxMs: number): Promise<void> {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => { const done = () => { window.removeEventListener('online', done); resolve(); }; window.addEventListener('online', done); setTimeout(done, maxMs); });
}
/** Browsers say "Failed to fetch" / "Load failed" for any network failure. Say what it means for Kino. */
const OFFLINE_MSG = 'Could not reach Kino. Is the Mac awake and on the network?';
const RETRIES = 3;
const RETRY_MS = [400, 1000, 2200];

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  // Reads and idempotent writes retry through a network blip; POSTs would double up, so they do not.
  const idempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await once<T>(method, url, body);
      if (method === 'GET') remember(url, out);
      return out;
    } catch (e) {
      const net = e instanceof TypeError;                            // fetch rejected: no connection, server gone, DNS
      const flaky = e instanceof ApiError && (e.status === 502 || e.status === 503 || e.status === 504);
      if (!(net || flaky) || !idempotent || attempt >= RETRIES) throw net ? new ApiError(0, OFFLINE_MSG) : e;
      await untilOnline(4000);
      await sleep(RETRY_MS[attempt] || 2200);
    }
  }
}

async function once<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (res.status === 401 && data && typeof data === 'object' && (data as { locked?: boolean }).locked) setStore({ locked: true });
  if (!res.ok) throw new ApiError(res.status, errorText(res.status, text), codeIn(text));
  return data as T;
}
/**
 * What a failed answer says to the person: Kino's own `{ error }` text, else a short line with the status. Never
 * the body itself: an HTML error page, a proxy's or a router's text.
 */
export function errorText(status: number, body: string): string {
  let e: unknown;
  try { e = (JSON.parse(body) as { error?: unknown } | null)?.error; } catch { /* not JSON */ }
  return typeof e === 'string' && e.trim() ? e : `Kino could not do that (error ${status})`;
}
/** The `code` next to the `{ error }` in a failed answer, if there is one. */
export function codeIn(body: string): string | undefined {
  let c: unknown;
  try { c = (JSON.parse(body) as { code?: unknown } | null)?.code; } catch { /* not JSON */ }
  return typeof c === 'string' && c ? c : undefined;
}
const get = <T>(u: string) => req<T>('GET', u);
const post = <T>(u: string, b?: unknown) => req<T>('POST', u, b ?? {});
const put = <T>(u: string, b?: unknown) => req<T>('PUT', u, b ?? {});
const del = <T>(u: string) => req<T>('DELETE', u);
const enc = encodeURIComponent;

/** A browser target tells the streams ranking which codecs it decodes; asked once. Part of the url, so of the cache key. */
let decodes: string | undefined;
const streamsCaps = (target: Target) => (target === 'browser' ? (decodes ??= decodeQuery(caps())) : '');

/** Urls of the GET responses the screens keep across visits (see `cached`). */
export const urls = {
  home: () => '/api/home',
  meta: (type: string, id: string) => `/api/meta/${type}/${enc(id)}`,
  streams: (type: string, videoId: string, target: Target) => `/api/streams/${type}/${enc(videoId)}?target=${target}${streamsCaps(target)}`,
  similar: (type: string, id: string) => `/api/meta/${type}/${enc(id)}/similar`,
  genres: () => '/api/browse/genres',
};

export const api = {
  health: () => get<Health>('/health'),
  home: () => get<HomeResponse>(urls.home()),
  search: (q: string) => get<SearchResponse>(`/api/search?q=${enc(q)}`),
  similar: (type: string, id: string) => get<SimilarRail>(urls.similar(type, id)),
  browse: (type: BrowseType, opts: BrowseQuery) => get<BrowseResponse>(`/api/browse?type=${type}${opts.genre ? `&genre=${enc(opts.genre)}` : ''}${opts.sort ? `&sort=${opts.sort}` : ''}${opts.page ? `&page=${opts.page}` : ''}${opts.from != null ? `&from=${opts.from}` : ''}${opts.to != null ? `&to=${opts.to}` : ''}`),
  browseGenres: () => get<BrowseGenres>(urls.genres()),
  meta: (type: string, id: string) => get<MetaResponse>(urls.meta(type, id)),
  ratings: (type: string, id: string) => get<Ratings>(`/api/ratings/${type}/${enc(id)}`),
  streams: (type: string, videoId: string, target: Target) => get<StreamsResponse>(urls.streams(type, videoId, target)),
  /** A release played or cast from a source list, for the local pick log. Fire and forget. */
  logPick: (key: string, chosen: string, via: 'play' | 'cast' | 'auto', videoId?: string) => post<unknown>('/api/picks', { key, chosen, via, videoId }).catch(() => undefined),
  /** What happened to that release in the player (seconds), for the same log. Fire and forget. */
  logOutcome: (o: PickOutcomeReport) => post<unknown>('/api/picks/outcome', o).catch(() => undefined),
  play: (r: PlayRequest) => post<PlayResponse>('/api/play', r),
  hlsSeek: (sid: string, time: number) => post<HlsSeekResponse>(`/api/hls/${enc(sid)}/seek`, { time }),
  hlsPing: (sid: string) => post<OkResponse>(`/api/hls/${enc(sid)}/ping`).catch(() => undefined),
  hlsClose: (sid: string) => del<unknown>(`/api/hls/${enc(sid)}`).catch(() => undefined),
  torrentStats: (h: string) => get<TorrentStats>(`/api/torrent/${h}/stats`),
  torrentAdd: (magnet: string) => post<TorrentAddResponse>('/api/torrent/add', { magnet }),
  credits: (p: FileRef) => get<CreditsEstimate>(`/api/credits?infoHash=${enc(p.infoHash)}&fileIdx=${p.fileIdx}${p.videoId ? `&videoId=${enc(p.videoId)}` : ''}${p.metaId ? `&metaId=${enc(p.metaId)}` : ''}`),
  creditsLearn: (metaId: string, offset: number) => post<OkResponse>('/api/credits/learn', { metaId, offset }),
  intro: (p: FileRef) => get<IntroEstimate>(`/api/intro?infoHash=${enc(p.infoHash)}&fileIdx=${p.fileIdx}${p.videoId ? `&videoId=${enc(p.videoId)}` : ''}${p.metaId ? `&metaId=${enc(p.metaId)}` : ''}`),
  introLearn: (p: IntroLearnRequest) => post<OkResponse>('/api/intro/learn', p),
  subSync: (p: SubSyncRequest) => post<SubSyncResult>('/api/subs/sync', p),
  subs: (p: SubsQuery) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') q.set(k, String(v));
    return get<SubsResponse>(`/api/subs?${q}`);
  },
  progress: (videoId: string) => get<Progress | null>(`/api/progress/${enc(videoId)}`),
  removeProgress: (videoId: string) => del<OkResponse>(`/api/progress/${enc(videoId)}`),
  putProgress: (p: ProgressPatch) => put<Progress>(`/api/progress/${enc(p.videoId)}`, p),
  beaconProgress: (p: ProgressPatch) => {
    try { navigator.sendBeacon(`/api/progress/${enc(p.videoId)}`, new Blob([JSON.stringify(p)], { type: 'text/plain' })); } catch { /* ignore */ }
  },
  watchlist: () => get<MetaPreview[]>('/api/watchlist'),
  history: () => get<Progress[]>('/api/history'),
  addWatchlist: (id: string, b: WatchlistAdd) => put<unknown>(`/api/watchlist/${enc(id)}`, b),
  removeWatchlist: (id: string) => del<unknown>(`/api/watchlist/${enc(id)}`),
  following: () => get<Followed[]>('/api/following'),
  follow: (id: string, b: FollowAdd) => put<unknown>(`/api/following/${enc(id)}`, b),
  unfollow: (id: string) => del<unknown>(`/api/following/${enc(id)}`),
  castDevices: (refresh = false) => get<CastDevice[]>(`/api/cast/devices${refresh ? '?refresh=1' : ''}`),
  castStatus: () => get<CastStatus>('/api/cast/status'),
  castPlay: (r: CastPlayRequest) => post<CastStatus>('/api/cast/play', r),
  castPause: () => post<CastStatus>('/api/cast/pause'),
  castResume: () => post<CastStatus>('/api/cast/resume'),
  castNext: () => post<CastStatus>('/api/cast/next'),
  castSource: (infoHash: string, fileIdx?: number) => post<CastStatus>('/api/cast/source', { infoHash, fileIdx }),
  castUpNext: (cancel: boolean) => post<CastStatus>('/api/cast/upnext', { cancel }),
  castStop: () => post<CastStatus>('/api/cast/stop'),
  castSeek: (time: number) => post<CastStatus>('/api/cast/seek', { time }),
  castVolume: (b: VolumeRequest) => post<CastStatus>('/api/cast/volume', b),
  castSubtitle: (subId: string | null, offsetMs?: number) => post<CastStatus>('/api/cast/subtitle', { subId, offsetMs }),
  castReceivers: (refresh = false) => get<ReceiverInfo[]>(`/api/cast/receivers${refresh ? '?refresh=1' : ''}`),
  castPower: (id: string, on: boolean) => post<ReceiverInfo | null>(`/api/cast/receivers/${encodeURIComponent(id)}/power`, { on }),
  castReceiverCmd: (id: string, cmd: ReceiverCommand, body?: ReceiverCommandBody) => post<ReceiverInfo>(`/api/cast/receivers/${encodeURIComponent(id)}/${cmd}`, body || {}),
  castHistory: (id: string) => get<CastHistoryEntry[]>(`/api/cast/receivers/${encodeURIComponent(id)}/history`),
  castStopAll: () => post<ReceiverInfo[]>('/api/cast/stop-all'),
  castHandoff: () => post<CastHandoff | null>('/api/cast/handoff'),
  settings: () => get<Settings>('/api/settings'),
  putSettings: (s: Partial<Settings>) => put<Settings>('/api/settings', s),
  dismissRecovered: () => post<OkResponse>('/api/recovered/dismiss'),
  addons: () => get<AddonRow[]>('/api/addons'),
  addAddon: (url: string) => post<AddonInfo>('/api/addons', { url }),
  removeAddon: (url: string) => del<unknown>(`/api/addons?url=${enc(url)}`),
  downloads: () => get<DownloadInfo[]>('/api/downloads'),
  addDownload: (b: DownloadRequest) => post<DownloadInfo[]>('/api/downloads', b),
  removeDownload: (key: string) => del<DownloadInfo[]>(`/api/downloads/${enc(key)}`),
  addonCatalog: () => get<CatalogEntry[]>('/api/addons/catalog'),
  auth: (pin: string) => post<OkResponse>('/api/auth', { pin }),
  restore: (data: unknown) => post<RestoreResult>('/api/restore', data),
  disk: () => get<DiskReport>('/api/disk'),
  clearCache: (infoHash?: string) => post<DiskReport>('/api/cache/clear', infoHash ? { infoHash } : {}),
};
