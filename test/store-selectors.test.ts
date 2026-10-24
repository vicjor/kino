import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * A store selector must hand back something already in the store (or a primitive). A fresh [] or {} is a new
 * snapshot on every read, so useSyncExternalStore re-renders until React gives up (error #185), as a page does with
 * `useStore((s) => s.settings?.subLangs || [])`. Fix with a module-level constant (`?? NO_LANGS`), or select the
 * raw value and derive the rest in useMemo.
 */
const ROOT = path.resolve(import.meta.dirname, '..');

/** Calls that return a new array, object or iterator every time. */
const MAKERS = new Set(['filter', 'map', 'flatMap', 'flat', 'slice', 'concat', 'toSorted', 'toReversed', 'toSpliced', 'with', 'split', 'keys', 'values', 'entries', 'fromEntries', 'from', 'of', 'assign', 'structuredClone']);

/** Whether an expression builds a new object each time it runs. A heuristic: plain calls to our own functions pass. */
function fresh(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e) || ts.isNewExpression(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    return (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken) && (fresh(e.left) || fresh(e.right));
  }
  if (ts.isConditionalExpression(e)) return fresh(e.whenTrue) || fresh(e.whenFalse);
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
    return MAKERS.has(name);
  }
  return false;
}

/** What a selector function can return: its expression body, or every `return x` in its block (not in nested functions). */
function returned(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    n.forEachChild(walk);
  };
  fn.body.forEachChild(walk);
  return out;
}

/** The selector of a store read: useStore(sel), or the getSnapshot of useSyncExternalStore(subscribe, getSnapshot). */
function selectorOf(call: ts.CallExpression): ts.Expression | undefined {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  return name === 'useStore' ? call.arguments[0] : name === 'useSyncExternalStore' ? call.arguments[1] : undefined;
}

/** `file:line: selector` for every selector in src that returns a fresh array, object or function. */
function freshSelectors(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const sel = selectorOf(n);
      if (sel && (ts.isArrowFunction(sel) || ts.isFunctionExpression(sel)) && returned(sel).some(fresh)) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(sel.getStart(sf)).line + 1}: ${sel.getText(sf).replace(/\s+/g, ' ')}`);
      }
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

/**
 * TODO: hits in files another session owns, as `file: selector` (no line number, so edits around them do not
 * break the match). Empty today. Remove an entry once its selector is fixed (the staleness test says when).
 */
const ALLOW = new Set<string>([]);
const key = (hit: string) => hit.replace(/:\d+: /, ': ');

let scanned: string[] | undefined;
/** Every hit in client/, parsed once for both tests below. */
function clientHits(): string[] {
  const dir = path.join(ROOT, 'client');
  return scanned ??= (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).sort()
    .flatMap((f) => { const rel = `client/${f.split(path.sep).join('/')}`; return freshSelectors(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')); });
}

test('freshSelectors: flags selectors that build a new array, object or function on each read', () => {
  const hits = (src: string) => freshSelectors('x.tsx', src).map((h) => h.split(': ').slice(1).join(': '));
  const flagged = [
    'useStore((s) => s.settings?.subLangs || [])',
    'useStore((s) => s.settings?.subLangs ?? [])',
    'useStore((s) => s.cast.meta || {})',
    'useStore((s) => s.cast.meta ?? {})',
    'useStore((s) => ({ a: s.online, b: s.locked }))',
    'useStore((s) => [s.online, s.locked])',
    'useStore((s) => (s.receivers || []).filter((r) => r.online))',
    'useStore((s) => s.receivers?.map((r) => r.id))',
    'useStore((s) => s.ok ? [s.x] : null)',
    'useStore((s) => s.ok && { x: s.x })',
    'useStore((s) => new Set(s.ids))',
    'useStore((s) => Object.keys(s.map))',
    'useStore((s) => () => s.x)',
    'useStore(function (s) { if (!s.settings) return []; return s.settings.subLangs; })',
    'useStore((s) => { return s.list ?? {}; })',
    'useStore((s) => (s.subLangs || []) as string[])',
    'useSyncExternalStore(sub, () => [a, b])',
  ];
  for (const src of flagged) assert.equal(hits(`const x = ${src};`).length, 1, src);
  const fine = [
    'useStore((s) => s.settings?.subLangs ?? NO_LANGS)',
    'useStore((s) => s.receivers)',
    'useStore((s) => s.settings?.autoNextDelaySec || 15)',
    'useStore((s) => (s.receivers || []).some((r) => r.online))',
    'useStore((s) => (s.receivers || []).find((r) => r.online) || null)',
    'useStore((s) => (s.stats && s.stats.infoHash === h ? s.stats : null))',
    'useStore((s) => singleTv(s.receivers))',
    'useStore((s) => { const f = () => []; return s.list; })',
    'useStore(selectLangs)',
    'useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current)',
    'useMemo(() => [], [])',
  ];
  for (const src of fine) assert.deepEqual(hits(`const x = ${src};`), [], src);
  assert.deepEqual(freshSelectors('a/B.tsx', 'function B() {\n  const t = useStore((s) => s.subLangs || []);\n  return <div>{t.length}</div>;\n}'), ['a/B.tsx:2: (s) => s.subLangs || []']);
});

test('no store selector in client/ returns a fresh array or object', () => {
  assert.deepEqual(clientHits().filter((h) => !ALLOW.has(key(h))), [], 'Return a module-level constant (?? NO_LANGS) or select the raw value and derive it in useMemo');
});

test('every selector allowlist entry still matches a hit, so stale entries get removed', () => {
  const now = new Set(clientHits().map(key));
  assert.deepEqual([...ALLOW].filter((a) => !now.has(a)), []);
});
