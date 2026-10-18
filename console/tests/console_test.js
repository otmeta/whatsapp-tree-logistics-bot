/**
 * Tests for the Driver Requests Console data layer.
 *
 * Runs entirely against FakeSheets, so nothing here touches the production
 * spreadsheet. The important assertions are the safety ones: bot columns A–G are
 * never written, rows are addressed by Request ID rather than index, and every
 * triage change lands in the append-only activity log.
 *
 * Run: node console/tests/console_test.js
 */

const path = require('path');
const assert = require('assert');

const LIB = path.join(__dirname, '..', 'lib');
const owners = require(path.join(LIB, 'owners'));
const model = require(path.join(LIB, 'model'));
const sheetsLib = require(path.join(LIB, 'sheets'));
const clientsLib = require(path.join(LIB, 'clients'));
const { Repository } = require(path.join(LIB, 'repository'));
const { FakeSheets } = require('./fake_sheets');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    process.stdout.write('✅ ' + name + '\n');
  } catch (err) {
    results.push({ name, pass: false });
    process.stdout.write('❌ ' + name + '\n     ' + err.message + '\n');
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    process.stdout.write('✅ ' + name + '\n');
  } catch (err) {
    results.push({ name, pass: false });
    process.stdout.write('❌ ' + name + '\n     ' + err.message + '\n');
  }
}

// ---------------------------------------------------------------- owners

check('every roster member is assignable', () => {
  assert.strictEqual(owners.assignableNames().length, 16);
  assert.ok(owners.isAssignable('Florent Myftari'));
  assert.ok(owners.isAssignable('Pedro Trabbold'));
  assert.ok(owners.isAssignable('Qays'));
});

check('Maen Alkhateeb appears under both of his teams', () => {
  const groups = owners.assignableOwners();
  const auto = groups.find((g) => g.team === 'Auto Team');
  const recruiting = groups.find((g) => g.team === 'Recruiting Team');
  assert.ok(auto.people.includes('Maen Alkhateeb'), 'missing from Auto Team');
  assert.ok(recruiting.people.includes('Maen Alkhateeb'), 'missing from Recruiting Team');
  assert.strictEqual(owners.teamOf('Maen Alkhateeb'), 'Auto Team', 'primary team');
});

check('short first-name owners in the sheet group with their full roster name', () => {
  assert.strictEqual(owners.normalizeOwner('Boris'), 'Boris Toma');
  assert.strictEqual(owners.normalizeOwner('Sam'), 'Sam Jose');
  assert.strictEqual(owners.normalizeOwner('Fadi'), 'Fadi Nader');
  assert.strictEqual(owners.normalizeOwner('anderson'), 'Anderson Meta');
});

check('the sheet\'s existing dispatcher misspellings normalize to one owner', () => {
  assert.strictEqual(owners.normalizeOwner('Disaptcher DBE2'), 'Dispatcher DBE2');
  assert.strictEqual(owners.normalizeOwner('dispacher dbe2'), 'Dispatcher DBE2');
  assert.strictEqual(owners.normalizeOwner('Dispatcher DBE2'), 'Dispatcher DBE2');
});

check('blank owner becomes Unassigned', () => {
  assert.strictEqual(owners.normalizeOwner(''), 'Unassigned');
  assert.strictEqual(owners.normalizeOwner('   '), 'Unassigned');
  assert.strictEqual(owners.normalizeOwner(null), 'Unassigned');
});

check('legacy owners are kept for history but not assignable', () => {
  ['Amnery', 'Hugo', 'Adnan', 'Auto Team'].forEach((name) => {
    assert.ok(owners.isLegacy(name), name + ' should be legacy');
    assert.ok(!owners.isAssignable(name), name + ' should not be assignable');
  });
});

check('an unrecognised owner is preserved verbatim, not forced into the roster', () => {
  assert.strictEqual(owners.normalizeOwner('Someone New'), 'Someone New');
});

check('initials handle single and multi-part names', () => {
  assert.strictEqual(owners.initialsOf('Boris Toma'), 'BT');
  assert.strictEqual(owners.initialsOf('Qays'), 'QA');
  assert.strictEqual(owners.initialsOf('Maen Alkhateeb'), 'MA');
});

// ---------------------------------------------------------------- timestamps

check('sheet timestamps are read day-first, not month-first', () => {
  // 05/08/2026 is 5 August. Month-first parsing would make it 8 May.
  const d = model.parseSheetTimestamp('05/08/2026, 14:30:00');
  assert.strictEqual(d.getDate(), 5, 'day');
  assert.strictEqual(d.getMonth(), 7, 'month (0-indexed August)');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getHours(), 14);
});

check('a day-first date beyond 12 still parses', () => {
  const d = model.parseSheetTimestamp('17/08/2026, 07:05:00');
  assert.strictEqual(d.getDate(), 17);
  assert.strictEqual(d.getMonth(), 7);
});

check('impossible and unparseable dates return null rather than rolling over', () => {
  assert.strictEqual(model.parseSheetTimestamp('31/02/2026, 10:00:00'), null);
  assert.strictEqual(model.parseSheetTimestamp('not a date'), null);
  assert.strictEqual(model.parseSheetTimestamp(''), null);
  assert.strictEqual(model.parseSheetTimestamp(null), null);
});

check('age is whole days and never negative', () => {
  const now = new Date(2026, 7, 17, 9, 0, 0);
  assert.strictEqual(model.ageInDays('17/08/2026, 07:05:00', now), 0);
  assert.strictEqual(model.ageInDays('10/08/2026, 07:05:00', now), 7);
  assert.strictEqual(model.ageInDays('01/07/2026, 07:05:00', now), 47);
  // A clock-skewed future timestamp must not produce a negative age
  assert.strictEqual(model.ageInDays('20/08/2026, 07:05:00', now), 0);
  assert.strictEqual(model.ageInDays('rubbish', now), null);
});

check('aging colours and buckets follow the design thresholds', () => {
  assert.strictEqual(model.ageColor(3), '#5D6D63');
  assert.strictEqual(model.ageColor(7), '#5D6D63');
  assert.strictEqual(model.ageColor(8), '#8A5A00');
  assert.strictEqual(model.ageColor(21), '#8A5A00');
  assert.strictEqual(model.ageColor(22), '#B4291F');
  assert.strictEqual(model.agingBucket(0), '0–3 days');
  assert.strictEqual(model.agingBucket(5), '4–7 days');
  assert.strictEqual(model.agingBucket(21), '8–21 days');
  assert.strictEqual(model.agingBucket(60), '22+ days');
});

// ---------------------------------------------------------------- filters

const sample = [
  { id: 'R1', first: 'Yogesh', last: 'Savaliya', station: 'DBE3', status: 'To be contacted', owner: 'Unassigned', age: 30, text: 'Need Arbeitsvertrag for visa', category: '', phone: '+4917630672255' },
  { id: 'R2', first: 'Maria', last: 'Garcia', station: 'DBE2', status: 'In Progress', owner: 'Boris Toma', age: 4, text: 'Scanner broken', category: 'Scanner', phone: '+4917600000002' },
  { id: 'R3', first: 'Ali', last: 'Hassan', station: 'DBE3', status: 'Completed', owner: 'Amnery', age: 60, resolveDays: 2, text: 'Payslip request', category: 'Payroll', phone: '+4917600000003' },
  { id: 'R4', first: 'Nina', last: 'Braun', station: 'DBE2', status: 'To be contacted', owner: 'Unassigned', age: 12, text: 'Vacation in September', category: '', phone: '+4917600000002' }
];

check('Open excludes Completed', () => {
  const out = model.filterRequests(sample, { statusFilter: 'Open' });
  assert.deepStrictEqual(out.map((r) => r.id), ['R1', 'R4', 'R2']);
});

check('queue is sorted oldest first', () => {
  const ages = model.filterRequests(sample, { statusFilter: 'All' }).map((r) => r.age);
  assert.deepStrictEqual(ages, [60, 30, 12, 4]);
});

check('Unassigned ignores status', () => {
  const out = model.filterRequests(sample, { statusFilter: 'Unassigned' });
  assert.deepStrictEqual(out.map((r) => r.id), ['R1', 'R4']);
});

check('station and status and search compose together', () => {
  const out = model.filterRequests(sample, { station: 'DBE2', statusFilter: 'Open', query: 'vacation' });
  assert.deepStrictEqual(out.map((r) => r.id), ['R4']);
});

check('search matches full name, request id and request text', () => {
  assert.deepStrictEqual(
    model.filterRequests(sample, { statusFilter: 'All', query: 'yogesh savaliya' }).map((r) => r.id), ['R1']);
  assert.deepStrictEqual(
    model.filterRequests(sample, { statusFilter: 'All', query: 'r3' }).map((r) => r.id), ['R3']);
  assert.deepStrictEqual(
    model.filterRequests(sample, { statusFilter: 'All', query: 'arbeitsvertrag' }).map((r) => r.id), ['R1']);
});

check('duplicates count open requests sharing a phone number only', () => {
  const rows = JSON.parse(JSON.stringify(sample));
  model.markDuplicates(rows);
  const byId = {};
  rows.forEach((r) => { byId[r.id] = r; });
  // R2 (open) and R4 (open) share a number
  assert.ok(byId.R2.isDuplicate, 'R2 should be flagged');
  assert.ok(byId.R4.isDuplicate, 'R4 should be flagged');
  assert.ok(!byId.R1.isDuplicate, 'R1 is alone');
  assert.ok(!byId.R3.isDuplicate, 'R3 is completed');
});

check('dashboard KPIs and workload are computed correctly', () => {
  const stats = model.dashboardStats(sample);
  assert.strictEqual(stats.kpis.total, 4);
  assert.strictEqual(stats.kpis.open, 3);
  assert.strictEqual(stats.kpis.completed, 1);
  assert.strictEqual(stats.kpis.unassigned, 2);
  assert.strictEqual(stats.kpis.overSeven, 2); // ages 30 and 12
  // Unassigned sorts first in the workload table
  assert.strictEqual(stats.byOwner[0].owner, 'Unassigned');
  assert.strictEqual(stats.byOwner[0].open, 2);
  // Needs attention = unassigned or older than 21 days
  assert.deepStrictEqual(stats.needsAttention.map((r) => r.id), ['R1', 'R4']);
  const aging = {};
  stats.aging.forEach((a) => { aging[a.label] = a.count; });
  assert.strictEqual(aging['22+ days'], 1);
  assert.strictEqual(aging['8–21 days'], 1);
  assert.strictEqual(aging['4–7 days'], 1);
  // Open charts ignore completed history. R3 is Completed and must not appear.
  assert.deepStrictEqual(stats.openStatusMix.map((s) => s.name), ['To be contacted', 'In Progress']);
  assert.strictEqual(stats.openStatusMix[0].count, 2);
  assert.deepStrictEqual(stats.overdue.map((r) => r.id), ['R1']);
  assert.deepStrictEqual(stats.arriving.map((r) => r.id), ['R4']);
  assert.strictEqual(stats.kpis.newToday, 0);
  const categories = {};
  stats.openByCategory.forEach((c) => { categories[c.name] = c.count; });
  assert.strictEqual(categories.Scanner, 1);
  assert.strictEqual(categories.Uncategorised, 2);
  assert.ok(!categories.Payroll, 'completed payroll is not open work');
});

check('avg days to resolve measures creation to completion, not age', () => {
  // R3 is 60 days old but was resolved in 2. Reporting 60 would be badly wrong.
  const stats = model.dashboardStats(sample);
  assert.strictEqual(stats.kpis.avgDays, 2, 'should use resolveDays, not age');
  assert.strictEqual(stats.kpis.avgDaysCoverage, 1);
  assert.strictEqual(stats.kpis.completedCount, 1);
});

check('with no completion dates the resolve metric is null, never guessed from age', () => {
  const noDates = sample.map((r) => {
    const copy = Object.assign({}, r);
    delete copy.resolveDays;
    return copy;
  });
  const stats = model.dashboardStats(noDates);
  assert.strictEqual(stats.kpis.avgDays, null);
  assert.strictEqual(stats.kpis.avgDaysCoverage, 0);
});

check('the read-only Completed At field is not writable by triage', () => {
  assert.ok(sheetsLib.WRITABLE_OFFICE_FIELDS.indexOf('completedAt') === -1);
});

// ---------------------------------------------------------------- clients

check('the contract is read from the station prefix', () => {
  assert.strictEqual(clientsLib.clientOf('DBE2'), 'amazon');
  assert.strictEqual(clientsLib.clientOf('DBE3'), 'amazon');
  assert.strictEqual(clientsLib.clientOf('VOI Berlin'), 'voi');
  assert.strictEqual(clientsLib.clientOf('voi hamburg'), 'voi');
  assert.strictEqual(clientsLib.clientOf(''), 'other');
});

check('all 583 historical Amazon rows classify without a backfill', () => {
  // Every existing row starts DBE, so nothing needs rewriting in the sheet.
  ['DBE2', 'DBE3'].forEach((station) => {
    assert.strictEqual(clientsLib.clientOf(station), 'amazon', station);
    assert.strictEqual(clientsLib.locationOf(station), station);
  });
});

check('the location is the city for VOI and the station for Amazon', () => {
  assert.strictEqual(clientsLib.locationOf('VOI Berlin'), 'Berlin');
  assert.strictEqual(clientsLib.locationOf('VOI  Hamburg'), 'Hamburg');
  assert.strictEqual(clientsLib.locationOf('VOI'), '(no city)');
  assert.strictEqual(clientsLib.locationOf('DBE2'), 'DBE2');
});

check('VOI has a default owner and Amazon does not', () => {
  assert.strictEqual(clientsLib.defaultOwnerFor('voi'), 'Anderson Meta');
  assert.strictEqual(clientsLib.defaultOwnerFor('amazon'), null);
});

check('the default owner must be someone on the roster', () => {
  const suggested = clientsLib.defaultOwnerFor('voi');
  assert.ok(owners.isAssignable(suggested), suggested + ' is not assignable');
});

check('filter locations come from the data, so a new city needs no deploy', () => {
  const rows = [
    { station: 'VOI Berlin' }, { station: 'VOI Berlin' },
    { station: 'VOI Lübeck' }, { station: 'DBE2' }
  ];
  assert.deepStrictEqual(clientsLib.locationsFor(rows, 'voi'), ['Berlin', 'Lübeck']);
  assert.deepStrictEqual(clientsLib.locationsFor(rows, 'amazon'), ['DBE2']);
});

// ---------------------------------------------------------------- mixed filtering

const mixed = [
  { id: 'A1', first: 'Yogesh', last: 'S', station: 'DBE3', status: 'To be contacted', owner: 'Unassigned', age: 30, text: 'papers', category: '', phone: '+491' },
  { id: 'A2', first: 'Maria', last: 'G', station: 'DBE2', status: 'In Progress', owner: 'Boris Toma', age: 4, text: 'scanner', category: '', phone: '+492' },
  { id: 'V1', first: 'Elena', last: 'P', station: 'VOI Berlin', status: 'To be contacted', owner: 'Unassigned', age: 12, text: 'payslip', category: '', phone: '+493' },
  { id: 'V2', first: 'Adil', last: 'S', station: 'VOI Hamburg', status: 'To be contacted', owner: 'Anderson Meta', age: 2, text: 'clothes', category: '', phone: '+494' },
  { id: 'V3', first: 'Nina', last: 'B', station: 'VOI Berlin', status: 'Completed', owner: 'Anderson Meta', age: 40, text: 'done', category: '', phone: '+495' }
];

check('filtering by contract separates VOI from Amazon', () => {
  assert.deepStrictEqual(
    model.filterRequests(mixed, { client: 'voi', statusFilter: 'All' }).map((r) => r.id),
    ['V3', 'V1', 'V2']);
  assert.deepStrictEqual(
    model.filterRequests(mixed, { client: 'amazon', statusFilter: 'All' }).map((r) => r.id),
    ['A1', 'A2']);
});

check('within VOI you can filter down to one city', () => {
  assert.deepStrictEqual(
    model.filterRequests(mixed, { client: 'voi', station: 'Berlin', statusFilter: 'All' }).map((r) => r.id),
    ['V3', 'V1']);
});

check('contract and status filters compose', () => {
  assert.deepStrictEqual(
    model.filterRequests(mixed, { client: 'voi', statusFilter: 'Open' }).map((r) => r.id),
    ['V1', 'V2']);
  assert.deepStrictEqual(
    model.filterRequests(mixed, { client: 'voi', statusFilter: 'Unassigned' }).map((r) => r.id),
    ['V1']);
});

check('filtering by owner shows only that person\'s work', () => {
  assert.deepStrictEqual(
    model.filterRequests(mixed, { owner: 'Anderson Meta', statusFilter: 'All' }).map((r) => r.id),
    ['V3', 'V2']);
});

check('owner composes with status, so "my open requests" works', () => {
  assert.deepStrictEqual(
    model.filterRequests(mixed, { owner: 'Anderson Meta', statusFilter: 'Open' }).map((r) => r.id),
    ['V2']);
});

check('owner composes with contract too', () => {
  assert.deepStrictEqual(
    model.filterRequests(mixed, { owner: 'Boris Toma', client: 'amazon', statusFilter: 'All' }).map((r) => r.id),
    ['A2']);
  assert.deepStrictEqual(
    model.filterRequests(mixed, { owner: 'Boris Toma', client: 'voi', statusFilter: 'All' }).map((r) => r.id),
    []);
});

check('Unassigned is selectable as an owner', () => {
  assert.deepStrictEqual(
    model.filterRequests(mixed, { owner: 'Unassigned', statusFilter: 'All' }).map((r) => r.id),
    ['A1', 'V1']);
});

check('no owner filter leaves the queue untouched', () => {
  assert.strictEqual(model.filterRequests(mixed, { statusFilter: 'All' }).length, 5);
  assert.strictEqual(model.filterRequests(mixed, { owner: 'All', statusFilter: 'All' }).length, 5);
});

check('no contract filter still shows everything, as before', () => {
  assert.strictEqual(model.filterRequests(mixed, { statusFilter: 'All' }).length, 5);
});

check('the dashboard splits the two contracts', () => {
  const stats = model.dashboardStats(mixed);
  const byKey = {};
  stats.byClient.forEach((c) => { byKey[c.client] = c; });

  assert.strictEqual(byKey.amazon.total, 2);
  assert.strictEqual(byKey.amazon.open, 2);
  assert.strictEqual(byKey.voi.total, 3);
  assert.strictEqual(byKey.voi.open, 2);
  assert.strictEqual(byKey.voi.unassigned, 1, 'only V1 has nobody on it');
  assert.strictEqual(byKey.amazon.unassigned, 1);
});

// ---------------------------------------------------------------- write guard

check('columnLetter maps indices to A1 letters', () => {
  assert.strictEqual(sheetsLib.columnLetter(1), 'A');
  assert.strictEqual(sheetsLib.columnLetter(8), 'H');
  assert.strictEqual(sheetsLib.columnLetter(9), 'I');
  assert.strictEqual(sheetsLib.columnLetter(26), 'Z');
  assert.strictEqual(sheetsLib.columnLetter(27), 'AA');
});

check('every bot-owned column A–G is refused', () => {
  for (let col = 1; col <= 7; col++) {
    assert.throws(() => sheetsLib.assertWritable(col, false), /A-G belong to the bot/,
      'column ' + sheetsLib.columnLetter(col) + ' should be refused');
    assert.throws(() => sheetsLib.assertWritable(col, true), /A-G belong to the bot/,
      'column ' + sheetsLib.columnLetter(col) + ' should be refused even for status');
  }
});

check('column H is writable only as the status field', () => {
  assert.throws(() => sheetsLib.assertWritable(8, false), /outside the status field/);
  assert.strictEqual(sheetsLib.assertWritable(8, true), 8);
});

check('office columns from I onward are writable', () => {
  assert.strictEqual(sheetsLib.assertWritable(9, false), 9);
  assert.strictEqual(sheetsLib.assertWritable(14, false), 14);
});

// ---------------------------------------------------------------- integration

function buildRepo(opts) {
  const options = opts || {};
  const header = options.header || [
    'Timestamp', 'First Name', 'Last Name', 'Station', 'Request/Question',
    'Request ID', 'Phone Number', 'Status', 'Owner', 'Priority', 'DA Contacted',
    'Out or still with us', 'Action', 'Notes'
  ];

  const rows = options.rows || [
    ['17/08/2026, 07:05:00', 'Yogesh', 'Savaliya', 'DBE3', 'Need Arbeitsvertrag for my visa', 'REQ-1001', 'whatsapp:+4917630672255', 'To be contacted', '', '', '', '', '', ''],
    ['10/08/2026, 09:00:00', 'Maria', 'Garcia', 'DBE2', 'Scanner is broken', 'REQ-1002', 'whatsapp:+4917600000002', 'In Progress', 'Boris', 'High', '', '', '', ''],
    ['01/07/2026, 08:00:00', 'Ali', 'Hassan', 'DBE3', 'Payslip please', 'REQ-1003', 'whatsapp:+4917600000003', 'Completed', 'Amnery', '', '', '', '', '']
  ];

  const tabs = { 'Driver Requests': [header].concat(rows) };
  if (options.withActivityTab) tabs['Activity Log'] = [sheetsLib.ACTIVITY_HEADERS.slice()];

  const fake = new FakeSheets(tabs);
  const client = new sheetsLib.SheetsClient({
    spreadsheetId: 'STUB',
    fetchImpl: fake.fetch,
    tokenProvider: async () => 'stub-token'
  });
  const repo = new Repository({
    sheets: client,
    cacheMs: 0,
    now: () => new Date(2026, 7, 17, 9, 0, 0)
  });

  return { fake, client, repo };
}

const ACTOR = { name: 'Anderson Meta', team: 'Admin' };

(async function run() {
  await checkAsync('requests are read and mapped from the sheet', async () => {
    const { repo } = buildRepo();
    const snap = await repo.snapshot(true);
    assert.strictEqual(snap.requests.length, 3);

    const first = snap.requests[0];
    assert.strictEqual(first.id, 'REQ-1001');
    assert.strictEqual(first.first, 'Yogesh');
    assert.strictEqual(first.station, 'DBE3');
    assert.strictEqual(first.age, 0);
    assert.strictEqual(first.owner, 'Unassigned');

    // "Boris" in the sheet is displayed under the roster name
    assert.strictEqual(snap.requests[1].owner, 'Boris Toma');
    assert.strictEqual(snap.requests[1].ownerRaw, 'Boris', 'raw value preserved');
    assert.strictEqual(snap.requests[1].age, 7);
  });

  await checkAsync('office columns are located by header name, not fixed letters', async () => {
    // Someone inserted "Completed At" before the office block.
    const { repo, fake } = buildRepo({
      header: [
        'Timestamp', 'First Name', 'Last Name', 'Station', 'Request/Question',
        'Request ID', 'Phone Number', 'Status', 'Completed At', 'Owner', 'Priority'
      ],
      rows: [
        ['17/08/2026, 07:05:00', 'Yogesh', 'Savaliya', 'DBE3', 'Need papers', 'REQ-1001', 'whatsapp:+491', 'To be contacted', '', 'Sam', 'Low']
      ]
    });

    const snap = await repo.snapshot(true);
    assert.strictEqual(snap.requests[0].owner, 'Sam Jose', 'owner read from column J');
    assert.strictEqual(snap.requests[0].priority, 'Low');

    await repo.applyTriage('REQ-1001', { owner: 'Pedro Trabbold' }, ACTOR);
    const ownerWrite = fake.writes.find((w) => w.sheet === 'Driver Requests' && w.value === 'Pedro Trabbold');
    assert.strictEqual(ownerWrite.col, 10, 'must write column J, not I');
    assert.strictEqual(fake.botColumnWrites().length, 0);
  });

  await checkAsync('a status change writes only column H and logs it', async () => {
    const { repo, fake } = buildRepo();
    const res = await repo.applyTriage('REQ-1001', { status: 'In Progress' }, ACTOR);

    assert.ok(res.changed);
    const statusWrites = fake.writes.filter((w) => w.sheet === 'Driver Requests');
    assert.strictEqual(statusWrites.length, 1);
    assert.strictEqual(statusWrites[0].col, 8, 'column H');
    assert.strictEqual(statusWrites[0].row, 2);
    assert.strictEqual(statusWrites[0].value, 'In Progress');

    const logged = fake.appends.filter((a) => a.sheet === 'Activity Log');
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].row[1], 'REQ-1001');
    assert.strictEqual(logged[0].row[2], 'Anderson Meta');
    assert.strictEqual(logged[0].row[4], 'Status set to In Progress.');
  });

  await checkAsync('the write goes to the row matching the Request ID, not a cached index', async () => {
    const { repo, client, fake } = buildRepo();
    await repo.snapshot(true); // REQ-1003 is row 4 at this point

    // The bot appends a new request and someone re-sorts the sheet underneath us.
    const grid = fake.tabs['Driver Requests'];
    const moved = grid.splice(3, 1)[0];      // pull REQ-1003 out of row 4
    grid.splice(1, 0, moved);                // and put it at row 2
    client.refreshHeaders();

    await repo.applyTriage('REQ-1003', { status: 'Not started' }, ACTOR);

    const write = fake.writes.find((w) => w.sheet === 'Driver Requests' && w.col === 8);
    assert.strictEqual(write.row, 2, 'must follow the request, not the stale index');
    assert.strictEqual(fake.tabs['Driver Requests'][1][5], 'REQ-1003', 'row 2 really is REQ-1003');
  });

  await checkAsync('a missing Category column is created rather than overwriting a neighbour', async () => {
    const { repo, fake } = buildRepo();
    const before = fake.tabs['Driver Requests'][0].length;

    await repo.applyTriage('REQ-1001', { category: 'Documents' }, ACTOR);

    const headerRow = fake.tabs['Driver Requests'][0];
    assert.strictEqual(headerRow.length, before + 1, 'one new column');
    assert.strictEqual(headerRow[before], 'Category');
    const write = fake.writes.find((w) => w.value === 'Documents');
    assert.strictEqual(write.col, before + 1);
    assert.strictEqual(fake.botColumnWrites().length, 0);
  });

  await checkAsync('several triage changes at once each get their own activity entry', async () => {
    const { repo, fake } = buildRepo();
    await repo.applyTriage('REQ-1001', {
      status: 'In Progress',
      owner: 'Diana Ionita',
      priority: 'High',
      contacted: 'Phone'
    }, ACTOR);

    const texts = fake.appends.map((a) => a.row[4]);
    assert.strictEqual(texts.length, 4, JSON.stringify(texts));
    assert.ok(texts.includes('Status set to In Progress.'));
    assert.ok(texts.includes('Assigned to Diana Ionita.'));
    assert.ok(texts.includes('Priority set to High.'));
    assert.ok(texts.includes('Driver contacted via Phone.'));
    assert.strictEqual(fake.botColumnWrites().length, 0);
  });

  await checkAsync('an unchanged value is not written and not logged', async () => {
    const { repo, fake } = buildRepo();
    const res = await repo.applyTriage('REQ-1002', { status: 'In Progress', priority: 'High' }, ACTOR);
    assert.strictEqual(res.changed, false);
    assert.strictEqual(fake.writes.filter((w) => w.sheet === 'Driver Requests').length, 0);
    assert.strictEqual(fake.appends.length, 0);
  });

  await checkAsync('an invalid status is rejected before anything is written', async () => {
    const { repo, fake } = buildRepo();
    await assert.rejects(
      () => repo.applyTriage('REQ-1001', { status: 'Done' }, ACTOR),
      /Unknown status/
    );
    assert.strictEqual(fake.writes.length, 0);
    assert.strictEqual(fake.appends.length, 0);
  });

  await checkAsync('a legacy owner cannot be assigned to new work', async () => {
    const { repo, fake } = buildRepo();
    await assert.rejects(
      () => repo.applyTriage('REQ-1001', { owner: 'Amnery' }, ACTOR),
      /Not an assignable owner/
    );
    assert.strictEqual(fake.writes.length, 0);
  });

  await checkAsync('an unknown contact method is rejected', async () => {
    const { repo } = buildRepo();
    await assert.rejects(
      () => repo.applyTriage('REQ-1001', { contacted: 'Telepathy' }, ACTOR),
      /Unknown contact method/
    );
  });

  await checkAsync('writing to a request that is not in the sheet fails cleanly', async () => {
    const { repo } = buildRepo();
    await assert.rejects(
      () => repo.applyTriage('REQ-NOPE', { status: 'In Progress' }, ACTOR),
      /not found/
    );
  });

  await checkAsync('the activity tab is created on first use with its headers', async () => {
    const { repo, fake } = buildRepo();
    assert.ok(!fake.tabs['Activity Log'], 'should not exist yet');

    await repo.logAction('REQ-1001', 'Called the driver, sending contract tomorrow.', ACTOR);

    assert.ok(fake.created.includes('Activity Log'));
    assert.deepStrictEqual(fake.tabs['Activity Log'][0], sheetsLib.ACTIVITY_HEADERS);
    const entry = fake.appends[0].row;
    assert.strictEqual(entry[1], 'REQ-1001');
    assert.strictEqual(entry[2], 'Anderson Meta');
    assert.strictEqual(entry[3], 'Admin');
    assert.strictEqual(entry[4], 'Called the driver, sending contract tomorrow.');
  });

  await checkAsync('an empty action note is a no-op', async () => {
    const { repo, fake } = buildRepo({ withActivityTab: true });
    const res = await repo.logAction('REQ-1001', '   ', ACTOR);
    assert.strictEqual(res.changed, false);
    assert.strictEqual(fake.appends.length, 0);
  });

  await checkAsync('activity is read back newest first and attached to its request', async () => {
    const { repo } = buildRepo({ withActivityTab: true });
    await repo.logAction('REQ-1001', 'First call', ACTOR);
    await repo.logAction('REQ-1001', 'Second call', ACTOR);

    const request = await repo.getRequest('REQ-1001');
    assert.strictEqual(request.activity.length, 2);
    assert.strictEqual(request.activity[0].text, 'Second call', 'newest first');
  });

  await checkAsync('the request text is never written back anywhere', async () => {
    const { repo, fake } = buildRepo();
    await repo.applyTriage('REQ-1001', { status: 'Completed', owner: 'Ali Butt' }, ACTOR);
    await repo.logAction('REQ-1001', 'Resolved', ACTOR);

    const driverSheetWrites = fake.writes.filter((w) => w.sheet === 'Driver Requests');
    driverSheetWrites.forEach((w) => {
      assert.ok(w.col >= 8, 'wrote column ' + sheetsLib.columnLetter(w.col));
    });
    assert.strictEqual(fake.tabs['Driver Requests'][1][4], 'Need Arbeitsvertrag for my visa',
      'request text untouched');
  });

  await checkAsync('rows with no Request ID are hidden but left alone', async () => {
    const { repo, fake } = buildRepo({
      rows: [
        ['17/08/2026, 07:05:00', 'Yogesh', 'Savaliya', 'DBE3', 'Papers', 'REQ-1001', 'whatsapp:+491', 'To be contacted'],
        ['manual note added by hand', '', '', '', '', '', '', '']
      ]
    });
    const snap = await repo.snapshot(true);
    assert.strictEqual(snap.requests.length, 1);
    assert.strictEqual(fake.tabs['Driver Requests'][2][0], 'manual note added by hand');
  });

  await checkAsync('the snapshot is cached so viewers do not each hit the API', async () => {
    const { repo, fake } = buildRepo();
    repo.cacheMs = 60000;
    await repo.snapshot(true);
    const after = fake.requestCount;
    await repo.snapshot();
    await repo.snapshot();
    assert.strictEqual(fake.requestCount, after, 'no extra API calls');
  });

  await checkAsync('a write invalidates the cache so the next read is fresh', async () => {
    const { repo } = buildRepo();
    repo.cacheMs = 60000;
    await repo.snapshot(true);
    await repo.applyTriage('REQ-1001', { status: 'In Progress' }, ACTOR);
    const request = await repo.getRequest('REQ-1001');
    assert.strictEqual(request.status, 'In Progress');
  });

  // ---- cost of a change (these guard the responsiveness of the dropdowns) ----

  await checkAsync('a triage change returns the updated request, so no reload is needed', async () => {
    const { repo } = buildRepo();
    repo.cacheMs = 60000;
    await repo.snapshot(true);

    const res = await repo.applyTriage('REQ-1001', { status: 'In Progress', owner: 'Diana Ionita' }, ACTOR);
    assert.ok(res.request, 'no request returned');
    assert.strictEqual(res.request.id, 'REQ-1001');
    assert.strictEqual(res.request.status, 'In Progress');
    assert.strictEqual(res.request.owner, 'Diana Ionita');
    assert.ok(res.request.activity.length >= 2, 'activity should be attached');
    assert.strictEqual(res.request.activity[0].text, 'Assigned to Diana Ionita.', 'newest first');
  });

  await checkAsync('reading straight after a write costs no further API calls', async () => {
    const { repo, fake } = buildRepo();
    repo.cacheMs = 60000;
    await repo.snapshot(true);
    await repo.applyTriage('REQ-1001', { status: 'In Progress' }, ACTOR);

    const before = fake.requestCount;
    const request = await repo.getRequest('REQ-1001');
    assert.strictEqual(fake.requestCount, before, 'the cache should have been patched, not dropped');
    assert.strictEqual(request.status, 'In Progress', 'and it must reflect the write');
  });

  await checkAsync('several fields changed at once cost one append, not one each', async () => {
    const { repo, fake } = buildRepo({ withActivityTab: true });
    repo.cacheMs = 60000;
    await repo.snapshot(true);

    const before = fake.requestCount;
    await repo.applyTriage('REQ-1001', {
      status: 'In Progress', owner: 'Diana Ionita', priority: 'High', contacted: 'Phone'
    }, ACTOR);
    const calls = fake.requestCount - before;

    // Row lookup + cell write + one batched append.
    assert.strictEqual(calls, 3, 'expected 3 API calls, got ' + calls);
    assert.strictEqual(fake.appends.length, 4, 'all four notes must still be recorded');
  });

  await checkAsync('the tab list is fetched once, not before every append', async () => {
    const { repo, client, fake } = buildRepo({ withActivityTab: true });
    repo.cacheMs = 60000;
    await repo.snapshot(true);

    await repo.logAction('REQ-1001', 'First note', ACTOR);
    await repo.logAction('REQ-1001', 'Second note', ACTOR);
    await repo.logAction('REQ-1001', 'Third note', ACTOR);

    assert.ok(client._titleCache, 'titles should be cached');
    assert.strictEqual(fake.appends.length, 3, 'all three notes written');
  });

  await checkAsync('creating the activity tab still refreshes the cached tab list', async () => {
    const { repo, client, fake } = buildRepo(); // no Activity Log tab yet
    repo.cacheMs = 60000;
    await repo.snapshot(true);

    await repo.logAction('REQ-1001', 'First ever note', ACTOR);
    assert.ok(fake.created.includes('Activity Log'));

    // A stale cache here would make the next append target a tab we think is absent.
    const titles = await client.sheetTitles();
    assert.ok(titles.includes('Activity Log'), 'cache must include the new tab');
  });

  await checkAsync('a failed write leaves the cache untouched', async () => {
    const { repo, fake } = buildRepo();
    repo.cacheMs = 60000;
    await repo.snapshot(true);

    await assert.rejects(
      () => repo.applyTriage('REQ-1001', { status: 'Nonsense' }, ACTOR),
      /Unknown status/
    );

    const request = await repo.getRequest('REQ-1001');
    assert.strictEqual(request.status, 'To be contacted', 'must not show a change that never happened');
    assert.strictEqual(fake.writes.length, 0);
  });

  // ---- summary ----
  const failed = results.filter((r) => !r.pass);
  process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n');
  if (failed.length) {
    process.stdout.write('\nFAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n') + '\n');
  }
  process.exit(failed.length ? 1 : 0);
})();
