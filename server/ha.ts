import { getState } from './store.js';
import { logger, errMsg } from './log.js';
const log = logger('ha');

/** Opt-in: POST playback events to a Home Assistant webhook so automations can dim lights etc. */
export function haEvent(event: 'play' | 'pause' | 'stop', data: Record<string, unknown> = {}): void {
  const url = getState().settings.haWebhookUrl;
  if (!url) return;
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, ...data, ts: Date.now() }), signal: AbortSignal.timeout(3000) })
    .then((r) => { if (!r.ok) log.warn('webhook non-ok', { status: r.status }); })
    .catch((e) => log.warn('webhook failed', { err: errMsg(e) }));
}
