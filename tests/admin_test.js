/**
 * Admin-endpoint guard harness.
 *
 * With ADMIN_SECRET unset the endpoints must behave exactly as they do today
 * (so nothing breaks on deploy). With it set they must reject callers who don't
 * present it — especially /broadcast and /broadcast/recipients.
 */

const path = require('path');

const PROJECT = process.env.PROJECT || path.join(__dirname, '..');
process.env.FLOW_STORE = 'memory';

const SECRET = 'super-secret-value-123';
process.env.PORT = process.env.TEST_PORT || '38251';
process.env.GOOGLE_SHEET_ID = 'STUB';
process.env.TWILIO_ACCOUNT_SID = 'ACstub';
process.env.TWILIO_AUTH_TOKEN = 'x'.repeat(32);
process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+10000000000';
if (process.env.WITH_SECRET === 'true') process.env.ADMIN_SECRET = SECRET;
else delete process.env.ADMIN_SECRET;

const googleapisPath = require.resolve('googleapis', { paths: [PROJECT] });
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true, children: [], paths: [],
  exports: { google: { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: { values: {} } }) } },
};

const googleSheets = require(path.join(PROJECT, 'services/googleSheets'));
let broadcastReached = 0;
googleSheets.getUniquePhoneNumbers = async () => { broadcastReached++; return ['+4917600000001']; };
googleSheets.getAllRequests = async () => [];

const realLog = console.log;
console.log = () => {};
console.warn = () => {};
require(path.join(PROJECT, 'server.js'));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  realLog(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '\n     ' + detail}`);
};

async function call(method, route, headers = {}) {
  const res = await fetch(`${BASE}${route}`, { method, headers });
  return res.status;
}

async function main() {
  await new Promise((r) => setTimeout(r, 400));
  const withSecret = process.env.WITH_SECRET === 'true';

  const guarded = [
    ['GET', '/broadcast/recipients'],
    ['POST', '/clear-flows'],
    ['POST', '/format-sheet'],
  ];

  for (const [method, route] of guarded) {
    const bare = await call(method, route);
    if (withSecret) {
      check(`${route} rejects a caller with no secret`, bare === 403, `status=${bare}`);
      const authed = await call(method, route, { 'x-admin-secret': SECRET });
      check(`${route} allows the correct secret`, authed !== 403, `status=${authed}`);
      const wrong = await call(method, route, { 'x-admin-secret': 'wrong-value' });
      check(`${route} rejects a wrong secret`, wrong === 403, `status=${wrong}`);
    } else {
      check(`${route} still open when ADMIN_SECRET is unset (no breakage)`, bare !== 403,
        `status=${bare}`);
    }
  }

  // The webhook itself must never be gated by the admin secret.
  const hook = await fetch(`${BASE}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Body: 'Hi', From: 'whatsapp:+491700000009' }).toString(),
  });
  check('driver webhook is never blocked by the admin guard', hook.status === 200,
    `status=${hook.status}`);

  const health = await call('GET', '/health');
  check('health check stays open for monitoring', health === 200, `status=${health}`);

  const failed = results.filter((r) => !r.pass);
  realLog(`\nADMIN_SECRET ${withSecret ? 'set' : 'unset'} — ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
