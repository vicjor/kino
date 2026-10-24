declare module 'webtorrent' {
  import { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';
  export interface TorrentFile {
    name: string; path: string; length: number; offset: number; downloaded: number; progress: number;
    select(priority?: number): void; deselect(): void;
    createReadStream(opts?: { start?: number; end?: number }): Readable;
  }
  export interface Torrent extends EventEmitter {
    infoHash: string; name: string; magnetURI: string; files: TorrentFile[]; path: string;
    numPeers: number; downloadSpeed: number; uploadSpeed: number; progress: number; downloaded: number; uploaded: number;
    length: number; ready: boolean; done: boolean; destroyed: boolean; pieceLength: number;
    announce: string[];
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
    deselect(start: number, end: number): void;
    pause(): void; resume(): void;
  }
  export interface AddOpts { path?: string; deselect?: boolean; announce?: string[]; strategy?: 'rarest' | 'sequential'; destroyStoreOnDestroy?: boolean; maxWebConns?: number }
  export default class WebTorrent extends EventEmitter {
    constructor(opts?: { maxConns?: number; dht?: boolean | object; utp?: boolean; tracker?: boolean | object; torrentPort?: number; downloadLimit?: number; uploadLimit?: number; webSeeds?: boolean });
    torrents: Torrent[];
    add(id: string, opts?: AddOpts, cb?: (t: Torrent) => void): Torrent;
    get(id: string): Promise<Torrent | null>;
    remove(id: string | Torrent, opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): Promise<void>;
    destroy(cb?: (err?: Error) => void): void;
    downloadSpeed: number; uploadSpeed: number;
  }
}
