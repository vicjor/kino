declare module 'bittorrent-tracker' {
  import { EventEmitter } from 'node:events';
  export interface ScrapeData { announce: string; infoHash: string; complete: number; incomplete: number; downloaded?: number }
  export default class Client extends EventEmitter {
    constructor(opts: { infoHash: Buffer | string; peerId: Buffer | string; announce: string[]; port: number });
    scrape(opts: { infoHash: Buffer[] }): void;
    destroy(cb?: () => void): void;
  }
}
