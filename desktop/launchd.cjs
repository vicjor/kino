// A launchd Kino on this Mac (scripts/install.sh, `make install-local`): the port it serves. Pure, so
// test/desktop.test.ts loads it directly.
'use strict';

/** The PORT a com.kino plist gives its server, the server's own default (1234) when it sets none. */
function plistPort(xml) {
  const m = /<key>PORT<\/key>\s*<string>\s*(\d+)\s*<\/string>/.exec(String(xml || ''));
  return m ? Number(m[1]) : 1234;
}

module.exports = { plistPort };
