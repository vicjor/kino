// Shared DTOs between server and client. Client imports this file type-only.

export type MediaType = 'movie' | 'series';
export type Target = 'browser' | 'ios' | 'chromecast';
export type PlayMode = 'direct' | 'hls-copy' | 'hls-transcode';

export interface MetaPreview {
  id: string;            // imdb id "tt123"
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  year?: string;         // releaseInfo, e.g. "2019" or "2019-"
  imdbRating?: string;
  tmdbRating?: string;   // TMDB's score, shown when there is no IMDb one
  genres?: string[];
  description?: string;
  watched?: boolean;     // browse only: you have this in your history
}

export interface Episode {
  id: string;            // "tt123:1:2"
  season: number;
  episode: number;
  title: string;
  released?: string;     // ISO date
  thumbnail?: string;
  overview?: string;
}

export interface Meta extends MetaPreview {
  logo?: string;
  runtime?: string;
  cast?: string[];
  director?: string[];
  videos?: Episode[];    // series only
  trailer?: string;      // YouTube video id
}

export interface Progress {
  videoId: string;       // "tt123" or "tt123:1:2"
  metaId: string;        // "tt123"
  type: MediaType;
  pos: number;           // seconds
  dur: number;           // seconds
  updatedAt: number;     // epoch ms
  name: string;          // title (movie) or "Show S1E2 Episode title"
  poster?: string;
  background?: string;
  season?: number;
  episode?: number;
  // last used source so "continue" can skip source picking
  infoHash?: string;
  fileIdx?: number;
  // the subtitle you chose last time: null means you turned them off, unset means nothing chosen yet
  subId?: string | null;
  subLang?: string;
  subOffsetMs?: number;
}

export interface Source {
  id: string;            // `${infoHash}:${fileIdx}`
  infoHash: string;
  fileIdx?: number;
  addon: string;         // name of the addon that returned this source
  provider?: string;     // indexer / provider tag reported by the addon, if any
  releaseName: string;
  filename?: string;
  seeders?: number;
  /** The addon reports the same fixed number for every release of this provider (one addon may say 100 for all), not a live count. */
  seedersEstimated?: boolean;
  /** Kino asked the trackers itself just now; `seeders` is that count, not the addon's figure. */
  seedersLive?: boolean;
  /** The addon's own figure, kept when a live count replaced it in `seeders`: stale, but a second opinion. */
  seedersAddon?: number;
  sizeBytes?: number;
  resolution?: '2160p' | '1080p' | '720p' | '480p' | 'other';
  codec?: 'h264' | 'hevc' | 'av1' | 'other';
  hdr?: string;          // "HDR", "HDR10", "DV", "HDR10+"
  audio?: string;        // "DDP5.1", "Atmos", "DTS-HD", "AAC" ...
  sourceTag?: string;    // REMUX, BluRay, WEB-DL, WEBRip, HDTV, CAM, TS
  group?: string;
  bingeGroup?: string;
  /** Audio languages the release name announces (ISO-639-2). Empty = nothing said, assume original/English. */
  langs?: string[];
  /** Announces a non-English dub or dual audio: the default track may not be English. */
  foreignAudio?: 'dub' | 'dual';
  score: number;
  /** How many times over its swarm can deliver the file within the running time plus prefetch (score.ts headroom): below PICK.margin it may stop to buffer. */
  headroom?: number;
  warnings: string[];    // e.g. "HEVC: transcodes for Chromecast", "CAM"
}

export interface StreamsResponse {
  sources: Source[];
  auto?: string;         // source id picked by scorer for the requested target
  addonsQueried: string[];
  addonsFailed: string[];
  /** Names this answer in the local pick log: POST /api/picks with it when a release from the list is played. */
  pickKey?: string;
  /** The video asked for: sent along with a pick, so an answer the server forgot still logs (server/picks.ts). */
  videoId?: string;
}

export interface PlayRequest {
  infoHash?: string;
  magnet?: string;
  fileIdx?: number;
  target: Target;
  videoId?: string;      // for progress bookkeeping
  audioTrack?: number;   // index into probe.audio
  forceHls?: boolean;
  forceTranscode?: boolean;   // the player could not play the direct file or the copy: convert it (one fallback)
  caps?: { hevc?: boolean; mkv?: boolean; av1?: boolean; vp9?: boolean };  // client-detected playback capabilities
}

export interface ProbeInfo {
  container: string;
  duration: number;
  startTime?: number;     // first timestamp in the container (usually 0)
  video?: { codec: string; profile?: string; level?: number; width?: number; height?: number };
  audio: { index: number; codec: string; channels?: number; lang?: string; title?: string }[];
  subs: { index: number; codec: string; lang?: string; title?: string }[];
  chapters?: { start: number; end: number; title?: string }[];
}

export interface PlayResponse {
  mode: PlayMode;
  url: string;           // /api/file/... or /api/hls/<sid>/index.m3u8
  sessionId?: string;    // hls only
  infoHash: string;
  fileIdx: number;
  fileName: string;
  sizeBytes: number;
  probe?: ProbeInfo;
  audioIndex?: number;   // stream index of the audio track in use
  reason?: string;       // why not direct
}

export interface TorrentFileInfo {
  index: number;
  name: string;
  path: string;
  length: number;
  isVideo: boolean;
}

export interface TorrentStats {
  infoHash: string;
  numPeers: number;
  downloadSpeed: number;
  uploadSpeed: number;
  progress: number;      // 0..1 of the selected file
  downloaded: number;
  length: number;
  ready: boolean;
}

export interface SubtitleTrack {
  id: string;            // stable key, used in /api/subs/file/:id.vtt
  lang: string;          // ISO-639-2 (eng, nor) or "und"
  label: string;
  origin: 'opensubtitles' | 'embedded' | 'torrent' | 'addon';
  hashMatch?: boolean;
  recommended?: boolean; // the best pick in its language: from the torrent itself, a hash match, or an embedded track
  url: string;           // /api/subs/file/<id>.vtt
  available: boolean;    // embedded: false until the file is fully downloaded
}

export interface CastDevice {
  id: string;
  name: string;          // friendly name (fn)
  model: string;         // md
  host: string;
  port: number;
  audioOnly: boolean;
  kind?: 'cast' | 'dlna';   // Google Cast (default) or a DLNA/UPnP renderer such as an LG TV
}

/** Live state of any Cast receiver on the LAN, whoever is casting to it. */
export interface ReceiverInfo {
  id: string; name: string; model: string; audioOnly: boolean;
  online: boolean; error?: string;
  asleep?: boolean;                    // a TV Kino has seen before that is off now
  canWake?: boolean;                   // Kino knows its MAC and can turn it on over the network
  waking?: boolean;                    // being turned on right now
  canPowerOff?: boolean;               // an LG TV: Kino can turn it off over its own remote protocol
  volume: number; muted: boolean;
  kino: boolean;                       // Kino's own session is on this device
  kind?: 'cast' | 'dlna';
  app?: { id: string; name: string; status?: string };  // running app, if any (Spotify, YouTube, Default Media Receiver...)
  media?: { state: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED'; title?: string; subtitle?: string; artwork?: string; currentTime: number; duration?: number; contentType?: string };
  updatedAt: number;
}

/** One thing that played on a receiver. Cast has no history API, so Kino records what it sees. */
export interface CastHistoryEntry {
  ts: number; app: string; title: string; subtitle?: string; artwork?: string;
  kino?: { videoId?: string; infoHash: string; fileIdx: number; title: string; poster?: string; type: MediaType };
}

/** The episode Kino will play after the one casting now. Shown as a popup at the credits; `startsAt` set = counting down. */
export interface UpNext {
  episode: Episode;
  videoId: string;       // episode.id
  show: string;          // series name
  poster?: string;
  startsAt?: number;     // epoch ms when it plays by itself; absent = only on request
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export interface CastStatus {
  upNext?: UpNext;       // credits reached on a series episode
  stopAfter?: boolean;   // the viewer asked to stop after this episode (no auto-next)
  active: boolean;
  deviceId?: string;
  deviceName?: string;
  state?: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';
  currentTime?: number;
  duration?: number;
  volume?: number;
  muted?: boolean;
  activeSubId?: string;
  videoId?: string;
  title?: string;
  poster?: string;
  infoHash?: string;
  fileIdx?: number;
  mode?: PlayMode;
  timeOffset?: number;   // hls session start offset
  subOffsetMs?: number;
  type?: MediaType;
  subs?: SubtitleTrack[];
  error?: string;
}

export interface CastPlayRequest {
  deviceId: string;
  infoHash: string;
  fileIdx: number;
  videoId?: string;
  title: string;
  poster?: string;
  startTime?: number;
  subId?: string | null;   // unset: the subtitle remembered for this video; null: none
  subOffsetMs?: number;
  audioTrack?: number;   // absolute stream index, see ProbeInfo.audio
}

export interface Settings {
  addons: string[];          // manifest URLs
  subLangs: string[];        // ISO-639-2 preference order
  cacheCapBytes: number;
  minFreeBytes: number;
  haWebhookUrl?: string;
  omdbApiKey?: string;       // optional: unlocks Rotten Tomatoes / Metacritic
  tmdbApiKey?: string;       // optional: trending, recommendations and hidden gems on Home, episode stills
  autoSubs?: boolean;        // pick a subtitle in your language automatically (default on)
  subFontSize: number;       // percent, 100 = default
  autoNext: boolean;
  autoNextDelaySec: number;
  onboarded?: boolean;       // first-run walkthrough done
}

/** Ratings for a title. IMDb per episode comes from IMDb's dataset dumps; RT/Metacritic need an OMDb key. */
export interface Ratings {
  id: string;
  imdbUrl: string;
  imdb?: { rating: number; votes: number };
  rottenTomatoes?: string;   // "87%"
  metacritic?: string;       // "72"
  episodes?: Record<string, { rating: number; votes: number }>;   // videoId -> rating
}

interface DiskInfo {
  freeBytes: number;
  totalBytes: number;
  cacheBytes: number;
  cacheCapBytes: number;
  hlsBytes: number;
  entries: { infoHash: string; name: string; bytes: number; lastUsed: number; active: boolean }[];
}

/** A file kept selected until it is complete, to watch later without stutter. */
export interface Download {
  key: string;             // `${infoHash}:${fileIdx}`
  infoHash: string; fileIdx: number;
  videoId?: string; metaId?: string; type: MediaType;
  name: string; poster?: string; background?: string;
  sizeBytes: number; addedAt: number; done: boolean; doneAt?: number; error?: string;
}
export interface DownloadInfo extends Download { progress: number; downloaded: number; speed: number; peers: number; active: boolean }

/** One horizontal rail on Home, built server-side from TMDB, Cinemeta catalogs and the user's history. */
export interface DiscoverRow {
  key: string; title: string; items: MetaPreview[];
  reason?: string;       // why this rail is here, in plain words: "You watched 8 episodes"
  href?: string;         // a Browse page that continues the rail, when one exists
}

/** Browse: one catalog page, filtered and sorted. */
export type BrowseType = MediaType | 'all';
export type BrowseSort = 'top' | 'rated' | 'new';
export interface BrowseResponse { items: MetaPreview[]; page: number; more: boolean }
export interface BrowseGenres { movie: string[]; series: string[] }

export interface HomeResponse {
  continueWatching: Progress[];
  discover: DiscoverRow[];
  popularMovies: MetaPreview[];
  popularSeries: MetaPreview[];
  watchlist: MetaPreview[];
  following: MetaPreview[];     // shows you follow, for the Your list rail
  newEpisodes: { show: MetaPreview; episode: Episode }[];
  upcoming?: Upcoming[];        // next episode still to air, per show you follow or are watching
}

/** A show's next episode on its way: `more` is how many further episodes of that season are announced. */
export interface Upcoming { show: MetaPreview; episode: Episode; more: number }

export interface AddonInfo {
  url: string;
  name: string;
  version?: string;
  resources: string[];
  types: string[];
  ok: boolean;
  error?: string;
}

/** An addon you can install from the built-in catalog. */
export interface CatalogEntry {
  url: string; name: string; description: string; kind: 'streams' | 'subtitles' | 'both';
  types: string[]; recommended: boolean; installed: boolean; note?: string;
}

/**
 * What kind of failure an error is, for the screens that tell failures apart: sent as `code` next to an answer's
 * `error`, and on hls.state. The client words each one itself and never matches on the server's text.
 *   no-peers          nobody shared the torrent's file list in time
 *   unreadable        the file could not be read in time to start (a slow or dead torrent)
 *   disk-full         the disk is below the free space Settings keeps
 *   tool-broken       ffmpeg or ffprobe does not run on this machine
 *   transcode-failed  ffmpeg gave up on this file
 *   session-gone      the HLS session was stopped or replaced
 */
export type ErrorCode = 'no-peers' | 'unreadable' | 'disk-full' | 'tool-broken' | 'transcode-failed' | 'session-gone';

/**
 * What happened to a release picked from a source list, as the player saw it (POST /api/picks/outcome, server/picks.ts):
 *   stall        the stall sheet came up
 *   slow         the player said the download is slower than the video
 *   switch       the viewer switched to another source
 *   no-peers     playback stopped on that server code (ErrorCode), unreadable likewise
 *   ended-early  the file played straight through ran dry well before its end
 */
export type PickOutcome = 'stall' | 'slow' | 'switch' | 'no-peers' | 'unreadable' | 'ended-early';

/** GET /api/meta/:type/:id: the title, progress per video id, and whether it is saved or followed. */
export interface MetaResponse { meta: Meta; progress: Record<string, Progress>; inWatchlist: boolean; following: boolean }
/** GET /api/meta/:type/:id/similar: one rail of titles like this one. */
export interface SimilarRail { title: string; reason?: string; genre?: string; items: MetaPreview[] }
export interface SearchResponse { results: MetaPreview[] }
/** GET /api/following: a followed show as the Library lists it. */
export interface Followed { id: string; name: string; poster?: string }
/** The plain `{ ok }` answer of a write that returns nothing else. */
export interface OkResponse { ok: boolean }
/** POST /api/restore: how many titles in progress and in the watchlist after the merge. */
export interface RestoreResult { ok: boolean; progress: number; watchlist: number }

/** Kino found its state file unreadable and started fresh: where the old file went (when it could be moved), and when. */
export interface StateRecovered { movedTo?: string; at: number }
/**
 * A load repaired or pruned the state file and wrote it back: top-level fields repaired, unreadable progress entries
 * left out, short old progress and unused receivers' cast history pruned, and where the bytes from before went.
 */
export interface StateRepaired { repairedFields: number; droppedProgress: number; prunedProgress: number; prunedCastDevices: number; backup?: string; at: number }

/** GET /health. Without the PIN cookie only ok, version, uptime and busy; the rest only when unlocked. */
export interface Health {
  ok: boolean; version: string; uptime: number; busy: boolean;
  node?: string; freeBytes?: number; activeTorrents?: number;
  cast?: boolean; hlsSessions?: number; streams?: number;      // who is watching (server/health.ts Watching)
  castDevices?: number; lanIp?: string; hostname?: string | null;
  ffmpeg?: boolean; ffmpegPath?: string; ffmpegChecking?: boolean;
  ffprobe?: boolean; ffprobePath?: string; ffprobeChecking?: boolean;
  hwEncoder?: boolean; imdbDatasets?: number | null; platform?: string; dataDir?: string;
  stateRecovered?: StateRecovered; stateRepaired?: StateRepaired; pinPaused?: boolean;
}

/**
 * GET /api/disk: DiskInfo plus the downloads saved for later, their bytes (part of cacheBytes) and which entries
 * they are. They count toward the cache limit but are never evicted or cleared.
 */
export type DiskReport = Omit<DiskInfo, 'entries'> & { downloadBytes: number; entries: (DiskInfo['entries'][number] & { download: boolean })[] };

/** Why an addon is skipped for now: when it last failed and how. */
export interface AddonFailure { failedAt: number; reason: string }
/** An installed addon as Settings lists it. `skipped`: streams or subtitles are not asked of it for now, it did not answer lately. */
export type AddonRow = AddonInfo & { skipped?: AddonFailure };

/** Where the TV was when a cast stopped so the phone can take over (POST /api/cast/handoff; null when nothing was casting). */
export interface CastHandoff { videoId?: string; pos: number; infoHash: string; fileIdx: number; title: string; poster?: string }
/** A cast receiver command (POST /api/cast/receivers/:id/:cmd) and its body. */
export type ReceiverCommand = 'stop' | 'pause' | 'play' | 'volume' | 'seek';
export interface ReceiverCommandBody { level?: number; muted?: boolean; time?: number }
/** POST /api/cast/volume. */
export interface VolumeRequest { level?: number; muted?: boolean }

type EstimateConfidence = 'high' | 'medium' | 'low' | 'none';
/** GET /api/intro: where the opening titles start and end, in seconds, and how that was found. */
export interface IntroEstimate { start?: number; end?: number; source: 'chapter' | 'subtitles' | 'learned' | 'none'; confidence: EstimateConfidence }
/** GET /api/credits: where the end credits start, in seconds, and how that was found. */
export interface CreditsEstimate { at?: number; source: 'learned' | 'chapter' | 'subtitles' | 'none'; confidence: EstimateConfidence }
/** The file the intro and credits estimates are for, and the title they learn per. */
export interface FileRef { infoHash: string; fileIdx: number; videoId?: string; metaId?: string }
/** POST /api/intro/learn: titles you skipped by hand, from where to where. */
export interface IntroLearnRequest { metaId: string; start: number; end: number; infoHash?: string; fileIdx?: number; videoId?: string }

/** GET /api/browse query: everything but the type is optional. */
export interface BrowseQuery { genre?: string; sort?: BrowseSort; page?: number; from?: number; to?: number }
/** POST /api/hls/:sid/seek: the session that now plays from `timeOffset`. */
export interface HlsSeekResponse { url: string; sessionId: string; timeOffset: number }
/** POST /api/torrent/add: the torrent and its files. */
export interface TorrentAddResponse { infoHash: string; name: string; files: TorrentFileInfo[] }
/** GET /api/subs query: by video id, by file, or both. */
export interface SubsQuery { type?: string; videoId?: string; infoHash?: string; fileIdx?: number }
export interface SubsResponse { tracks: SubtitleTrack[] }
/** POST /api/subs/sync: align subtitle `id` to the speech of the file from `from` seconds. */
export interface SubSyncRequest { id: string; infoHash: string; fileIdx: number; from: number }
/** The offset found and how well the cues matched speech (0 to 1). */
export interface SubSyncResult { offsetMs: number; score: number }
/** POST /api/picks/outcome: what happened to a release picked from a list, `pos` and `watchedSec` in seconds. */
export interface PickOutcomeReport { videoId: string; chosen: string; outcome: PickOutcome; pos: number; watchedSec: number }
/** PUT /api/progress/:videoId: any fields of a progress entry, keyed by its video id. */
export type ProgressPatch = Partial<Progress> & { videoId: string };
/** PUT /api/watchlist/:id and /api/following/:id. */
export interface WatchlistAdd { type: MediaType; name: string; poster?: string }
export interface FollowAdd { name: string; poster?: string }
/** POST /api/downloads: the file to keep, and what to show for it. */
export interface DownloadRequest { infoHash: string; fileIdx?: number; videoId?: string; metaId?: string; type?: MediaType; name?: string; poster?: string; background?: string }

// SSE events (name -> payload)
export interface Events {
  'cast.status': CastStatus;
  'cast.receivers': ReceiverInfo[];
  'torrent.stats': TorrentStats;
  'downloads': DownloadInfo[];
  'hls.state': { sessionId: string; state: 'starting' | 'ready' | 'ended' | 'error'; error?: string; code?: ErrorCode };
  'server.restart': Record<string, never>;   // last words before a shutdown (announceShutdown)
}
