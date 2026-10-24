declare module 'castv2-client' {
  import { EventEmitter } from 'node:events';
  export interface MediaTrack {
    trackId: number; type: 'TEXT' | 'AUDIO' | 'VIDEO'; trackContentId: string; trackContentType: string;
    subtype?: 'SUBTITLES' | 'CAPTIONS'; name?: string; language?: string;
  }
  export interface MediaInfo {
    contentId: string; contentType: string; streamType: 'BUFFERED' | 'LIVE';
    metadata?: Record<string, unknown>; tracks?: MediaTrack[]; textTrackStyle?: Record<string, unknown>;
    duration?: number;
  }
  export interface MediaStatus {
    mediaSessionId: number; playbackRate: number; playerState: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';
    currentTime: number; supportedMediaCommands: number; volume: { level: number; muted: boolean };
    activeTrackIds?: number[]; media?: MediaInfo & { duration?: number }; idleReason?: string;
  }
  export interface ReceiverApp { appId: string; displayName: string; sessionId: string; transportId: string; namespaces?: { name: string }[]; statusText?: string }
  export interface ReceiverStatus { volume: { level: number; muted: boolean }; applications?: ReceiverApp[] }
  export class Client extends EventEmitter {
    connect(host: string | { host: string; port?: number }, cb: () => void): void;
    close(): void;
    launch<T>(app: unknown, cb: (err: Error | null, player: T) => void): void;
    getSessions(cb: (err: Error | null, sessions: { appId: string; transportId: string; sessionId: string }[]) => void): void;
    join<T>(session: { appId: string; transportId: string }, app: unknown, cb: (err: Error | null, player: T) => void): void;
    getStatus(cb: (err: Error | null, status: ReceiverStatus) => void): void;
    setVolume(vol: { level?: number; muted?: boolean }, cb: (err: Error | null, vol: { level: number; muted: boolean }) => void): void;
    stop(player: unknown, cb: (err: Error | null) => void): void;
  }
  export class DefaultMediaReceiver extends EventEmitter {
    static APP_ID: string;
    media: { sessionRequest(data: Record<string, unknown>, cb?: (err: Error | null, res: unknown) => void): void };
    load(media: MediaInfo, opts: { autoplay?: boolean; currentTime?: number; activeTrackIds?: number[] }, cb: (err: Error | null, status: MediaStatus) => void): void;
    play(cb: (err: Error | null, status: MediaStatus) => void): void;
    pause(cb: (err: Error | null, status: MediaStatus) => void): void;
    stop(cb: (err: Error | null, status: MediaStatus) => void): void;
    seek(t: number, cb: (err: Error | null, status: MediaStatus) => void): void;
    getStatus(cb: (err: Error | null, status: MediaStatus | null) => void): void;
    close(): void;
  }
}
