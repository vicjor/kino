import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerKeyRoute, anyPlayerSheet, type PlayerSheets, type AppOverlays } from '../client/lib/player-keys.ts';
import { startChord, endChord } from '../client/lib/keys.ts';

// client/lib/player-keys.ts: which key presses the player answers while its sheets come and go.

const none: PlayerSheets = { keys: false, subs: false, cast: false, sources: false, audio: false, sleep: false, stall: false, episodes: false };
const key = (k: string, extra: object = {}) => ({ key: k, ...extra });
const app: AppOverlays = { ccOpen: false, palOpen: false };

test('anyPlayerSheet: false with nothing open, true for each sheet on its own', () => {
  assert.equal(anyPlayerSheet(none), false);
  for (const name of Object.keys(none) as (keyof PlayerSheets)[]) assert.equal(anyPlayerSheet({ ...none, [name]: true }), true, name);
});

test('playerKeyRoute: with no sheet open the player gets the key, Esc included', () => {
  assert.equal(playerKeyRoute(key('Escape'), 'DIV', none, app), 'player');
  assert.equal(playerKeyRoute(key('ArrowRight'), 'DIV', none, app), 'player', 'the focused seek bar is a div: one handler, one skip');
  assert.equal(playerKeyRoute(key(' '), 'BUTTON', none, app), 'player');
});

test('playerKeyRoute: Esc in the sleep timer or the stall sheet stays with the sheet, never leaves the player', () => {
  for (const name of ['sleep', 'stall', 'subs', 'cast', 'sources', 'audio'] as const) {
    const open = { ...none, [name]: true };
    assert.equal(playerKeyRoute(key('Escape'), 'BUTTON', open, app), 'ignore', name);
    assert.equal(playerKeyRoute(key('k'), 'BUTTON', open, app), 'ignore', `${name}: Space and K do not pause behind it`);
    assert.equal(playerKeyRoute(key('ArrowLeft'), 'BUTTON', open, app), 'ignore', name);
  }
});

test('playerKeyRoute: the shortcuts sheet closes on "?", Esc is left to the sheet', () => {
  const open = { ...none, keys: true };
  assert.equal(playerKeyRoute(key('?'), 'DIV', open, app), 'close-keys');
  assert.equal(playerKeyRoute(key('Escape'), 'DIV', open, app), 'ignore');
  assert.equal(playerKeyRoute(key('f'), 'DIV', open, app), 'ignore');
});

test('playerKeyRoute: typing, modifier chords and keys already handled elsewhere are not the player\'s', () => {
  assert.equal(playerKeyRoute(key('ArrowRight'), 'INPUT', none, app), 'ignore', 'the volume slider moves itself');
  assert.equal(playerKeyRoute(key('k'), 'TEXTAREA', none, app), 'ignore');
  assert.equal(playerKeyRoute(key('k', { metaKey: true }), 'DIV', none, app), 'ignore');
  assert.equal(playerKeyRoute(key('c', { ctrlKey: true }), 'DIV', none, app), 'ignore');
  assert.equal(playerKeyRoute(key('ArrowLeft', { altKey: true }), 'DIV', none, app), 'ignore');
  assert.equal(playerKeyRoute(key('c', { defaultPrevented: true }), 'DIV', none, app), 'ignore', 'the palette took "g c"');
  assert.equal(playerKeyRoute(key('?', { defaultPrevented: true }), 'DIV', { ...none, keys: true }, app), 'ignore');
  assert.equal(playerKeyRoute(key('Escape', { defaultPrevented: true }), 'DIV', none, app), 'ignore', 'the Cast Center closed on this Esc: the player stays');
  assert.equal(playerKeyRoute(key('k'), undefined, none, app), 'player', 'a key on the window itself');
});

test('playerKeyRoute: the Cast Center or the palette over the player owns every key, Esc and "?" included', () => {
  for (const over of [{ ccOpen: true, palOpen: false }, { ccOpen: false, palOpen: true }]) {
    for (const k of ['Escape', ' ', 'k', 'ArrowLeft', 'f', '?']) {
      assert.equal(playerKeyRoute(key(k), 'DIV', none, over), 'ignore', `${k} with ${JSON.stringify(over)}`);
      assert.equal(playerKeyRoute(key(k), 'DIV', { ...none, keys: true }, over), 'ignore', `${k} over the shortcuts sheet`);
    }
  }
});

test('playerKeyRoute: a key of a palette "g" chord is not the player\'s, whichever listener runs first', () => {
  const l = key('l');
  startChord();
  assert.equal(playerKeyRoute(l, 'DIV', none, app), 'ignore', 'the player listens before the palette: "g l" must not seek');
  endChord(l);
  assert.equal(playerKeyRoute(l, 'DIV', none, app), 'ignore', 'the player listens after the palette, same keydown');
  assert.equal(playerKeyRoute(key('l'), 'DIV', none, app), 'player', 'the next "l" seeks again');
});

test('playerKeyRoute: a caller may pass only the sheets it has', () => {
  assert.equal(playerKeyRoute(key('Escape'), 'DIV', { sources: false, cast: false }, app), 'player');
  assert.equal(playerKeyRoute(key('Escape'), 'DIV', { sources: true, cast: false }, app), 'ignore', 'the source list is open');
  assert.equal(playerKeyRoute(key('k'), 'DIV', { sources: false, cast: true }, app), 'ignore', 'the TV picker is open');
});
