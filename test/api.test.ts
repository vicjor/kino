import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText, codeIn } from '../client/lib/api.ts';

test('errorText: Kino\'s own { error } words, else a short line with the status, never the body', () => {
  const table: [number, string, string][] = [
    [404, '{"error":"Kino could not find this title"}', 'Kino could not find this title'],
    [500, '{"error":"Something went wrong on the Mac running Kino. The log has the details."}', 'Something went wrong on the Mac running Kino. The log has the details.'],
    [404, '<!DOCTYPE html><html><body><pre>Cannot GET /api/nope</pre></body></html>', 'Kino could not do that (error 404)'],
    [502, 'Bad Gateway', 'Kino could not do that (error 502)'],
    [503, '', 'Kino could not do that (error 503)'],
    [500, '{"error":""}', 'Kino could not do that (error 500)'],
    [500, '{"error":{"message":"x"}}', 'Kino could not do that (error 500)'],
    [400, '{"message":"no error field"}', 'Kino could not do that (error 400)'],
    [400, 'null', 'Kino could not do that (error 400)'],
    [400, '"a JSON string"', 'Kino could not do that (error 400)'],
    [413, '[1,2]', 'Kino could not do that (error 413)'],
  ];
  for (const [status, body, want] of table) assert.equal(errorText(status, body), want, body);
});

test('codeIn: the code next to Kino\'s { error }, else nothing', () => {
  assert.equal(codeIn('{"error":"Disk nearly full","code":"disk-full"}'), 'disk-full');
  for (const body of ['{"error":"x"}', '{"error":"x","code":""}', '{"error":"x","code":7}', '<html></html>', '', 'null', '[1]']) assert.equal(codeIn(body), undefined, body);
});
