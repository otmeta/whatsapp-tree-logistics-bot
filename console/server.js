/**
 * Driver Requests Console — HTTP layer.
 *
 * Deployed as its own service, separate from the WhatsApp bot, so a fault here
 * can never take down the driver-facing webhook. It shares only the spreadsheet
 * and the service-account credentials.
 *
 * ACCESS MODEL
 *   The Inbox shows unedited driver messages — names, phone numbers, and the
 *   IBANs the bot asks drivers to send — and it can write to the sheet. It is
 *   therefore gated behind one shared access code that the teams enter once per
 *   browser, which suits shared dispatcher terminals better than per-person
 *   accounts. Inside, each user picks who they are so activity entries are
 *   attributable.
 *
 *   The Dashboard is aggregate numbers only, with no driver names, phone numbers
 *   or request text, so it can be left on an open link (CONSOLE_PUBLIC_DASHBOARD).
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const { SheetsClient } = require('./lib/sheets');
const { Repository } = require('./lib/repository');
const owners = require('./lib/owners');
const clients = require('./lib/clients');
const model = require('./lib/model');

const VERSION = '1.3.0-open-queue';

const PORT = process.env.PORT || 4000;
const ACCESS_CODE = process.env.CONSOLE_ACCESS_CODE || '';
const OPEN_MODE = process.env.CONSOLE_OPEN === 'true';
const PUBLIC_DASHBOARD = process.env.CONSOLE_PUBLIC_DASHBOARD !== 'false';

// How often an open tab checks for new requests. Served to the client so it can
// be tuned in Railway without a deploy. Your own edits never wait for this —
// they apply immediately; this is only how fast someone else's arrive.
const POLL_SECONDS = Math.max(15, parseInt(process.env.CONSOLE_POLL_SECONDS || '300', 10) || 300);
const SESSION_COOKIE = 'trel_console';
const ACTOR_COOKIE = 'trel_actor';

// Fail loudly rather than starting an unprotected console over driver data.
if (!ACCESS_CODE && !OPEN_MODE) {
  console.error('='.repeat(64));
  console.error('❌ Refusing to start: no CONSOLE_ACCESS_CODE is set.');
  console.error('');
  console.error('   The Inbox exposes driver names, phone numbers and request');
  console.error('   text (which includes IBANs), and can write to the sheet.');
  console.error('');
  console.error('   Set CONSOLE_ACCESS_CODE to a shared code for the teams, or');
  console.error('   set CONSOLE_OPEN=true to deliberately run with no gate.');
  console.error('='.repeat(64));
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------- data layer

const sheets = new SheetsClient({
  spreadsheetId: process.env.GOOGLE_SHEET_ID,
  credentialsJson: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  sheetName: process.env.CONSOLE_SHEET_NAME || 'Driver Requests',
  activitySheetName: process.env.CONSOLE_ACTIVITY_SHEET || 'Activity Log'
});

const repo = new Repository({ sheets });

// ---------------------------------------------------------------- session

/** Cookie value proving the access code was entered, without storing the code. */
function sessionToken() {
  return crypto.createHmac('sha256', ACCESS_CODE).update('trel-console-session').digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  if (OPEN_MODE) return true;
  const cookies = parseCookies(req);
  const provided = cookies[SESSION_COOKIE] || '';
  const expected = sessionToken();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Who is acting, from the actor cookie. Only roster members are accepted. */
function currentActor(req) {
  const cookies = parseCookies(req);
  const name = cookies[ACTOR_COOKIE] || '';
  if (!owners.isAssignable(name)) return null;
  return { name: name, team: owners.teamOf(name) || '' };
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Access code required' });
}

function requireActor(req, res, next) {
  const actor = currentActor(req);
  if (!actor) {
    return res.status(400).json({ error: 'Select who you are before making changes' });
  }
  req.actor = actor;
  next();
}

// ---------------------------------------------------------------- auth routes

app.post('/api/session', function (req, res) {
  const code = String((req.body && req.body.code) || '');

  const a = Buffer.from(code);
  const b = Buffer.from(ACCESS_CODE);
  const ok = ACCESS_CODE && a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    console.warn('⚠️ Failed console access attempt');
    return res.status(401).json({ error: 'That code is not right.' });
  }

  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=' + sessionToken() +
    '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (60 * 60 * 24 * 30) +
    (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));

  res.json({ ok: true });
});

/** Sign out — matters on a shared dispatcher terminal. */
app.post('/api/logout', function (req, res) {
  const expire = '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
  res.setHeader('Set-Cookie', [SESSION_COOKIE + expire, ACTOR_COOKIE + '=; SameSite=Lax; Path=/; Max-Age=0']);
  res.json({ ok: true });
});

app.post('/api/actor', requireAuth, function (req, res) {
  const name = String((req.body && req.body.name) || '');
  if (!owners.isAssignable(name)) {
    return res.status(400).json({ error: 'Unknown person: ' + name });
  }

  res.setHeader('Set-Cookie',
    ACTOR_COOKIE + '=' + encodeURIComponent(name) +
    '; SameSite=Lax; Path=/; Max-Age=' + (60 * 60 * 24 * 365) +
    (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));

  res.json({ ok: true, actor: { name: name, team: owners.teamOf(name) } });
});

// ---------------------------------------------------------------- data routes

/** Everything the Inbox needs. Gated: contains driver PII. */
app.get('/api/state', requireAuth, async function (req, res) {
  try {
    const snap = await repo.snapshot();
    res.json({
      requests: snap.requests,
      syncedAt: snap.syncedAt,
      actor: currentActor(req),
      options: {
        statuses: model.STATUS_OPTIONS,
        priorities: model.PRIORITY_OPTIONS,
        categories: model.CATEGORY_OPTIONS,
        contactMethods: model.CONTACT_METHODS,
        owners: owners.assignableOwners(),
        legacyOwners: owners.LEGACY_OWNERS,
        teams: owners.TEAMS,
        clients: clients.CLIENTS
      }
    });
  } catch (err) {
    console.error('❌ /api/state failed:', err.message);
    res.status(502).json({ error: 'Could not read the sheet: ' + err.message });
  }
});

/**
 * Cheap "has anything changed?" probe. The full state payload is every request
 * in the sheet, so polling that every few seconds just to notice one new arrival
 * would be wasteful. The client polls this instead and only fetches the full
 * state when the totals move.
 */
app.get('/api/pulse', requireAuth, async function (req, res) {
  try {
    const snap = await repo.snapshot();
    const open = snap.requests.filter(function (r) { return model.isOpen(r.status); });

    res.json({
      total: snap.requests.length,
      openCount: open.length,
      // The bot appends, so the last row is the newest request.
      latestId: snap.requests.length ? snap.requests[snap.requests.length - 1].id : null,
      syncedAt: snap.syncedAt
    });
  } catch (err) {
    console.error('❌ /api/pulse failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Aggregate numbers only — safe to leave open. */
app.get('/api/dashboard', async function (req, res) {
  if (!PUBLIC_DASHBOARD && !isAuthed(req)) {
    return res.status(401).json({ error: 'Access code required' });
  }
  try {
    const data = await repo.dashboard();

    // Strip anything identifying from the attention tables when unauthenticated.
    if (!isAuthed(req)) {
      ['needsAttention', 'arriving', 'overdue'].forEach(function (key) {
        data.stats[key] = (data.stats[key] || []).map(function (r) {
          return { id: r.id, age: r.age, station: r.station, owner: r.owner, status: r.status };
        });
      });
    }

    res.json(data);
  } catch (err) {
    console.error('❌ /api/dashboard failed:', err.message);
    res.status(502).json({ error: 'Could not read the sheet: ' + err.message });
  }
});

app.post('/api/requests/:id/triage', requireAuth, requireActor, async function (req, res) {
  try {
    const result = await repo.applyTriage(req.params.id, req.body || {}, req.actor);
    res.json(result);
  } catch (err) {
    const status = err.code === 'REQUEST_NOT_FOUND' ? 404
      : (err.code && err.code.startsWith('INVALID')) ? 400 : 502;
    if (status === 502) console.error('❌ triage failed:', err.message);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

app.post('/api/requests/:id/activity', requireAuth, requireActor, async function (req, res) {
  try {
    const result = await repo.logAction(req.params.id, (req.body || {}).text, req.actor);
    res.json(result);
  } catch (err) {
    const status = err.code === 'REQUEST_NOT_FOUND' ? 404 : 502;
    if (status === 502) console.error('❌ activity log failed:', err.message);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------- shell

app.get('/health', function (req, res) {
  res.json({
    status: 'OK',
    version: VERSION,
    gated: !OPEN_MODE,
    publicDashboard: PUBLIC_DASHBOARD,
    pollSeconds: POLL_SECONDS,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/whoami', function (req, res) {
  res.json({
    authed: isAuthed(req),
    actor: currentActor(req),
    publicDashboard: PUBLIC_DASHBOARD,
    pollSeconds: POLL_SECONDS,
    owners: owners.assignableOwners()
  });
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, function () {
    console.log('='.repeat(60));
    console.log('🗂️  Driver Requests Console  ' + VERSION);
    console.log('   http://localhost:' + PORT);
    console.log('='.repeat(60));
    console.log('   Sheet:            ' + (process.env.GOOGLE_SHEET_ID ? '✅ set' : '❌ GOOGLE_SHEET_ID missing'));
    console.log('   Credentials:      ' + (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? '✅ set' : '❌ GOOGLE_APPLICATION_CREDENTIALS_JSON missing'));
    console.log('   Access gate:      ' + (OPEN_MODE ? '⚠️  OPEN — no code required' : '✅ shared code'));
    console.log('   Public dashboard: ' + (PUBLIC_DASHBOARD ? 'yes (aggregates only)' : 'no'));
    console.log('   Refresh interval: every ' + POLL_SECONDS + 's (CONSOLE_POLL_SECONDS)');
    console.log('   Roster:           ' + owners.assignableNames().length + ' people across ' + owners.TEAMS.length + ' teams');
    console.log('='.repeat(60));
  });
}

module.exports = { app, repo, sheets };
