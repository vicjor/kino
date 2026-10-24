import { addClient } from '../events.js';
import { apiRouter } from './util.js';
import { api as browse } from './browse.js';
import { api as library } from './library.js';
import { api as play } from './play.js';
import { api as subs } from './subs.js';
import { api as cast } from './cast.js';
import { api as settings } from './settings.js';

/**
 * The HTTP API, mounted at /api by server/index.ts: one router per part, in this order. No path is served by
 * two parts; route middleware (the progress beacon's text/plain parser) stays on its own route.
 */
export const api = apiRouter();
api.use(browse, library, play, subs, cast, settings);
api.get('/events', (_req, res) => addClient(res));
// Errors are answered by jsonErrors (errors.ts), mounted on the app so body parse failures get JSON too.
