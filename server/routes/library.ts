import express, { type Request, type Response } from 'express';
import { getState, update, saveProgress, getProgress, mergeProgress, progressBody } from '../store.js';
import { apiRouter, mt } from './util.js';

/** Watch progress, history, watchlist and the shows you follow. */
export const api = apiRouter();

api.get('/progress/:videoId', (req, res) => { res.json(getProgress(req.params.videoId as string) || null); });
// PUT from the player every 10 s; POST is what navigator.sendBeacon sends on page hide, same body.
const putProgress = (req: Request, res: Response) => {
  const videoId = req.params.videoId as string;
  const p = mergeProgress(getProgress(videoId), progressBody(req.body), videoId, Date.now());
  saveProgress(p);
  res.json(p);
};
api.put('/progress/:videoId', putProgress);
// sendBeacon cannot set application/json, so this one route also reads a text/plain body as JSON.
api.post('/progress/:videoId', express.json({ limit: '64kb', type: 'text/plain' }), putProgress);
api.delete('/progress/:videoId', (req, res) => { update((s) => { delete s.progress[req.params.videoId as string]; }); res.json({ ok: true }); });

/** What you watched, newest first: finished and unfinished alike, one entry per title. */
api.get('/history', (_req, res) => {
  const seen = new Set<string>();
  const out = Object.values(getState().progress).filter((p) => p.pos > 60).sort((a, b) => b.updatedAt - a.updatedAt).filter((p) => { const k = p.metaId || p.videoId; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
  res.json(out);
});
api.get('/watchlist', (_req, res) => res.json(getState().watchlist.map((w) => ({ id: w.id, type: w.type, name: w.name, poster: w.poster })).reverse()));
api.put('/watchlist/:id', (req, res) => {
  const { type, name, poster } = req.body || {};
  update((s) => { if (!s.watchlist.some((w) => w.id === req.params.id)) s.watchlist.push({ id: req.params.id as string, type: mt(type), name: name || req.params.id, poster, addedAt: Date.now() }); });
  res.json({ ok: true });
});
api.delete('/watchlist/:id', (req, res) => { update((s) => { s.watchlist = s.watchlist.filter((w) => w.id !== req.params.id); }); res.json({ ok: true }); });

api.get('/following', (_req, res) => res.json(getState().following.map((f) => ({ id: f.id, name: f.name, poster: f.poster }))));
api.put('/following/:id', (req, res) => {
  const { name, poster } = req.body || {};
  update((s) => { if (!s.following.some((f) => f.id === req.params.id)) s.following.push({ id: req.params.id as string, name: name || req.params.id, poster, addedAt: Date.now() }); });
  res.json({ ok: true });
});
api.delete('/following/:id', (req, res) => { update((s) => { s.following = s.following.filter((f) => f.id !== req.params.id); }); res.json({ ok: true }); });
