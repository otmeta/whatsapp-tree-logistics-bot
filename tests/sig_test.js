/**
 * Twilio signature-verification harness.
 *
 * Proves that a genuinely signed request validates against the URL the server
 * rebuilds behind Railway's proxy, and that a forged one is rejected once
 * TWILIO_VALIDATE_SIGNATURE=true. Run this before enabling enforcement.
 */

const path = require('path');

const PROJECT = process.env.PROJECT || path.join(__dirname, '..');
process.env.FLOW_STORE = 'memory';

const AUTH_TOKEN = 'a'.repeat(32);
const PUBLIC_HOST = 'whatsapp-tree-logistics-bot-production.up.railway.app';

process.env.PORT = process.env.TEST_PORT || '38231';
process.env.GOOGLE_SHEET_ID = 'STUB-SHEET';
process.env.TWILIO_ACCOUNT_SID = 'ACstub';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+10000000000';
process.env.TWILIO_VALIDATE_SIGNATURE = process.env.ENFORCE || 'false';

// Stub googleapis (slow to load, never exercised here)
const googleapisPath = require.resolve('googleapis', { paths: [PROJECT] });
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true, children: [], paths: [],
  exports: { google: { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: { values: {} } }) } },
};

const googleSheets = require(path.join(PROJECT, 'services/googleSheets'));
const saved = [];
googleSheets.addRequest = async (d) => { saved.push(d); return { success: true, rowId: d.rowId, row: 2 }; };

const twilio = require(path.join(PROJECT, 'node_modules/twilio'));

const logLines = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...a) => { logLines.push(a.join(' ')); };
console.warn = (...a) => { logLines.push(a.join(' ')); };

require(path.join(PROJECT, 'server.js'));

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  realLog(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '\n     ' + detail}`);
}

async function post(params, signature) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    // Mimic Railway's proxy headers
    'x-forwarded-proto': 'https',
    'x-forwarded-host': PUBLIC_HOST,
  };
  if (signature !== null) headers['x-twilio-signature'] = signature;

  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/webhook/whatsapp`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  await new Promise((r) => setTimeout(r, 400));

  const params = {
    Body: 'Hello',
    From: 'whatsapp:+491700000001',
    ProfileName: 'SigTester',
    MessageSid: 'SMsigtest0001',
    To: 'whatsapp:+10000000000',
  };

  // The URL the server rebuilds from the proxy headers
  const signedUrl = `https://${PUBLIC_HOST}/webhook/whatsapp`;
  const goodSig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, signedUrl, params);

  // --- genuine signature ---
  logLines.length = 0;
  const r1 = await post(params, goodSig);
  const sigOk = logLines.some((l) => l.includes('[SIGCHECK] OK'));
  check('a genuine Twilio signature validates against the rebuilt URL', sigOk,
    logLines.filter((l) => l.includes('SIGCHECK')).join(' | ') || 'no SIGCHECK line');
  check('genuine request is answered normally', r1.status === 200 && /Response/.test(r1.text),
    `${r1.status} ${r1.text.slice(0, 120)}`);

  // --- forged signature ---
  logLines.length = 0;
  const r2 = await post({ ...params, MessageSid: 'SMsigtest0002' }, 'Zm9yZ2Vkc2lnbmF0dXJl');
  const rejected = logLines.some((l) => l.includes('[SIGCHECK] REJECTED'));
  check('a forged signature is detected', rejected,
    logLines.filter((l) => l.includes('SIGCHECK')).join(' | ') || 'no SIGCHECK line');

  const enforcing = process.env.TWILIO_VALIDATE_SIGNATURE === 'true';
  if (enforcing) {
    check('forged signature is blocked with 403 when enforcing', r2.status === 403,
      `status=${r2.status}`);
  } else {
    check('forged signature still processed in log-only mode (safe rollout)',
      r2.status === 200, `status=${r2.status}`);
  }

  // --- missing signature ---
  logLines.length = 0;
  const r3 = await post({ ...params, MessageSid: 'SMsigtest0003' }, null);
  const missing = logLines.some((l) => l.includes('REJECTED-missing_signature'));
  check('a request with no signature at all is flagged', missing,
    logLines.filter((l) => l.includes('SIGCHECK')).join(' | '));
  if (enforcing) {
    check('unsigned request is blocked with 403 when enforcing', r3.status === 403,
      `status=${r3.status}`);
  }

  console.log = realLog;
  console.warn = realWarn;
  const failed = results.filter((r) => !r.pass);
  realLog(`\nmode=${enforcing ? 'ENFORCING' : 'log-only'} — ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
