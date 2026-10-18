/**
 * Conversation-flow harness for the Tree Logistics WhatsApp bot.
 *
 * Stubs the Google Sheets service BEFORE requiring server.js, so every scenario
 * runs against the real webhook handler without touching the production sheet.
 *
 * Run:  node flow_test.js            (from the repo root, via PROJECT env var)
 */

const path = require('path');

const PROJECT = process.env.PROJECT || path.join(__dirname, '..');

// The bot persists half-finished conversations. Tests must not write that file.
process.env.FLOW_STORE = 'memory';

// Keep the real .env out of it — the stub means no credentials are needed.
process.env.PORT = process.env.TEST_PORT || '38217';
process.env.GOOGLE_SHEET_ID = 'STUB-SHEET';
process.env.TWILIO_ACCOUNT_SID = 'ACstub';
process.env.TWILIO_AUTH_TOKEN = 'stubtoken';
process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+10000000000';

// ---- Stub googleapis so the real (very slow to load) SDK never gets required.
// Every Sheets call is stubbed below, so nothing here is ever exercised. ----
const googleapisPath = require.resolve('googleapis', { paths: [PROJECT] });
require.cache[googleapisPath] = {
  id: googleapisPath,
  filename: googleapisPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    google: {
      auth: { GoogleAuth: class { async getClient() { return {}; } } },
      sheets: () => ({ spreadsheets: { values: {} } }),
    },
  },
};

// ---- Stub Google Sheets before server.js captures the singleton ----
const googleSheets = require(path.join(PROJECT, 'services/googleSheets'));

const saved = [];
let failNextSaves = 0;

googleSheets.addRequest = async (requestData) => {
  if (failNextSaves > 0) {
    failNextSaves--;
    throw new Error('stubbed sheets failure');
  }
  saved.push(requestData);
  return { success: true, rowId: requestData.rowId, row: saved.length + 1 };
};
googleSheets.getRequestsByPhoneNumber = async () => [];
googleSheets.getAllRequests = async () => [];

// Silence the bot's very chatty logging unless DEBUG=1
if (!process.env.DEBUG) {
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
}

require(path.join(PROJECT, 'server.js'));

const BASE = `http://127.0.0.1:${process.env.PORT}`;

// ---- helpers ----
async function send(from, body, profileName = 'Tester') {
  const params = new URLSearchParams({
    Body: body,
    From: from,
    ProfileName: profileName,
    MessageSid: 'SM' + Math.random().toString(16).slice(2),
    AccountSid: 'ACstub',
    To: 'whatsapp:+10000000000',
  });

  const res = await fetch(`${BASE}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const xml = await res.text();
  const match = xml.match(/<Message>([\s\S]*)<\/Message>/);
  return { status: res.status, text: match ? match[1] : xml };
}

async function clearFlows() {
  await fetch(`${BASE}/clear-flows`, { method: 'POST' });
}

// ---- assertions ----
const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  const mark = condition ? '✅' : '❌';
  process.stdout.write(`${mark} ${name}${condition ? '' : '\n     ' + detail}\n`);
}

const REPLY = {
  welcome: /Welcome to Tree Logistics/i,
  // Re-prompt for identification: either the old "correct format" wording or the
  // newer message that names the missing piece.
  askAgain: /correct format|we still need|we also need/i,
  askRequest: /what you need help with/i,
  submitted: /submitted successfully/i,
  notSaved: /could NOT be saved/i,
};

let phoneSeq = 0;
const nextPhone = () => `whatsapp:+4915${String(1000000 + ++phoneSeq)}`;

async function main() {
  await new Promise((r) => setTimeout(r, 400)); // let the server bind

  // === Scenario 1: the documented happy path ===
  {
    const p = nextPhone();
    const r1 = await send(p, 'Hi');
    check('S1 greeting gets the welcome', REPLY.welcome.test(r1.text), r1.text);

    const r2 = await send(p, 'John Smith DBE2');
    check('S1 name+station is accepted', REPLY.askRequest.test(r2.text), r2.text);

    const before = saved.length;
    const r3 = await send(p, 'I need my Lohnabrechnung for July please');
    check('S1 request is confirmed', REPLY.submitted.test(r3.text), r3.text);
    check('S1 request reached the sheet', saved.length === before + 1,
      `saved went ${before} -> ${saved.length}`);
    if (saved.length > before) {
      const row = saved[saved.length - 1];
      check('S1 row has the right name/station',
        row.firstName === 'John' && row.lastName === 'Smith' && row.station === 'DBE2',
        JSON.stringify(row));
      check('S1 row keeps the full request text',
        /Lohnabrechnung for July/.test(row.request), row.request);
      check('S1 row is marked open for the office',
        row.status === 'To be contacted', String(row.status));
    }
  }

  // === Scenario 2: driver leads with the actual request ===
  {
    const p = nextPhone();
    const opening = 'I need a new scanner because mine is broken since yesterday';
    await send(p, opening);
    const r2 = await send(p, 'Maria Garcia DBE3');

    const landed = saved.find((s) => s.phoneNumber === p);
    check('S2 opening request is not thrown away',
      !!landed && /scanner/i.test(landed.request || ''),
      landed ? landed.request : `no row saved; reply was: ${r2.text}`);
  }

  // === Scenario 3: restart mid-conversation must not swallow the request ===
  {
    const p = nextPhone();
    await send(p, 'Hello');
    await send(p, 'Ahmed Hassan DBE2');
    await clearFlows(); // simulates a Railway restart wiping in-memory state

    // The driver now sends the request into a bot that has forgotten them.
    await send(p, 'I need login details for Emietarbeiter please');
    // They re-identify themselves and the held request must be submitted.
    await send(p, 'Ahmed Hassan DBE2');

    const landed = saved.find((s) => s.phoneNumber === p);
    check('S3 request sent during a restart still reaches the sheet',
      !!landed && /Emietarbeiter/i.test(landed.request || ''),
      landed ? landed.request : `nothing saved for ${p}`);
  }

  // === Scenario 4: station written first / name order variations ===
  {
    for (const [label, msg, expect] of [
      ['station last', 'Peter Klein DBE3', { firstName: 'Peter', lastName: 'Klein', station: 'DBE3' }],
      ['station first', 'DBE2 Anna Vogel', { firstName: 'Anna', lastName: 'Vogel', station: 'DBE2' }],
      ['station middle', 'Luis DBE3 Ferreira', { firstName: 'Luis', lastName: 'Ferreira', station: 'DBE3' }],
      ['lowercase station', 'Nina Braun dbe2', { firstName: 'Nina', lastName: 'Braun', station: 'DBE2' }],
    ]) {
      const p = nextPhone();
      await send(p, 'Hi');
      const r = await send(p, msg);
      const accepted = REPLY.askRequest.test(r.text);
      if (!accepted) {
        check(`S4 ${label} accepted`, false, r.text);
        continue;
      }
      await send(p, 'I have a question about my payslip amount this month');
      const row = saved.find((s) => s.phoneNumber === p);
      check(`S4 ${label} parsed correctly`,
        row && row.firstName === expect.firstName && row.lastName === expect.lastName &&
        row.station === expect.station,
        row ? JSON.stringify({ f: row.firstName, l: row.lastName, s: row.station }) : 'not saved');
    }
  }

  // === Scenario 5: no station given ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    const r = await send(p, 'Thomas Berger');
    check('S5 missing station is re-asked, not accepted',
      REPLY.askAgain.test(r.text) && !REPLY.askRequest.test(r.text), r.text);

    // Missing surname must be re-asked too, and say so.
    const p2 = nextPhone();
    await send(p2, 'Hi');
    const r2 = await send(p2, 'Thomas DBE2');
    check('S5 missing last name is re-asked',
      REPLY.askAgain.test(r2.text) && !REPLY.askRequest.test(r2.text), r2.text);
  }

  // === Scenario 6: the scanner follow-up keeps both messages ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    await send(p, 'Omar Farouk DBE3');
    await send(p, 'I need a scanner');          // triggers the status follow-up
    await send(p, 'it is broken completely');   // accepted on retry

    const row = saved.find((s) => s.phoneNumber === p);
    check('S6 follow-up keeps the original request text',
      row && /scanner/i.test(row.request) && /broken/i.test(row.request),
      row ? row.request : 'not saved');
  }

  // === Scenario 7: a sheet failure must NOT tell the driver it worked ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    await send(p, 'Sara Lopez DBE2');
    failNextSaves = 1;
    const r = await send(p, 'I need a confirmation letter for my landlord');
    check('S7 driver is told the truth when the sheet write fails',
      REPLY.notSaved.test(r.text) && !REPLY.submitted.test(r.text), r.text);

    // and a retry should then succeed without losing the request
    const r2 = await send(p, 'I need a confirmation letter for my landlord');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S7 retry after a failure lands in the sheet',
      !!row && REPLY.submitted.test(r2.text),
      row ? row.request : r2.text);
  }

  // === Scenario 8: very short request ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    await send(p, 'Nils Weber DBE3');
    await send(p, 'Payslip');            // under the 10-char floor
    const r2 = await send(p, 'Payslip'); // retry accepts
    const row = saved.find((s) => s.phoneNumber === p);
    check('S8 a short request still reaches the office within two tries',
      !!row && REPLY.submitted.test(r2.text), row ? row.request : r2.text);
  }

  // === Scenario 9: multi-line name+station (real traffic shape) ===
  {
    const p = nextPhone();
    await send(p, 'Hello');
    const r = await send(p, 'Yogeshkumar \nSavaliya \nDBE3');
    check('S9 multi-line name+station accepted', REPLY.askRequest.test(r.text), r.text);
    await send(p, 'I need the Arbeitsvertrag confirmation for my visa application');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S9 multi-line driver request saved',
      row && row.firstName === 'Yogeshkumar' && row.lastName === 'Savaliya',
      row ? JSON.stringify({ f: row.firstName, l: row.lastName }) : 'not saved');
  }

  // === Scenario 10: a long greeting must not become the request ===
  {
    for (const opener of ['Assalamu alaikum', 'Guten Morgen 👋👋', 'Hallo!!! 😊', 'thank you']) {
      const p = nextPhone();
      await send(p, opener);
      const r = await send(p, 'Elena Petrova DBE2');
      check(`S10 "${opener}" is treated as a greeting, not a request`,
        REPLY.askRequest.test(r.text) && !REPLY.submitted.test(r.text), r.text);
    }
  }

  // === Scenario 11: name+station as the opener is not mistaken for a request ===
  {
    const p = nextPhone();
    const r = await send(p, 'Fatima Al Sayed DBE3');
    check('S11 opening with name+station asks for the request',
      REPLY.welcome.test(r.text), r.text);
    const r2 = await send(p, 'Fatima Al Sayed DBE3');
    check('S11 name+station is then accepted, not saved as a request',
      REPLY.askRequest.test(r2.text) && !REPLY.submitted.test(r2.text), r2.text);
  }

  // === Scenario 12: VOI drivers, name and city in one message ===
  {
    for (const [label, msg, expect] of [
      ['city after VOI',  'Elena Petrova VOI Berlin',   { station: 'VOI Berlin', first: 'Elena', last: 'Petrova' }],
      ['city before VOI', 'Tomas Weber Berlin VOI',     { station: 'VOI Berlin', first: 'Tomas', last: 'Weber' }],
      ['VOI first',       'VOI Hamburg Nina Braun',     { station: 'VOI Hamburg', first: 'Nina', last: 'Braun' }],
      ['lowercase',       'ana silva voi kiel',         { station: 'VOI Kiel', first: 'ana', last: 'silva' }],
      ['city typo',       'Luis Ferreira VOI Flensberg', { station: 'VOI Flensburg', first: 'Luis', last: 'Ferreira' }],
    ]) {
      const p = nextPhone();
      await send(p, 'Hi');
      const r = await send(p, msg);
      if (!REPLY.askRequest.test(r.text)) {
        check(`S12 ${label} accepted`, false, r.text);
        continue;
      }
      await send(p, 'I need my Lohnabrechnung for this month please');
      const row = saved.find((s) => s.phoneNumber === p);
      check(`S12 ${label} -> ${expect.station}`,
        row && row.station === expect.station && row.firstName === expect.first && row.lastName === expect.last,
        row ? JSON.stringify({ s: row.station, f: row.firstName, l: row.lastName }) : 'not saved');
    }
  }

  // === Scenario 13: VOI without a city is asked only for the city ===
  {
    const p = nextPhone();
    await send(p, 'Hello');
    const r1 = await send(p, 'Diana Ionita VOI');
    check('S13 VOI with no city asks which city',
      /which city/i.test(r1.text) && !REPLY.askRequest.test(r1.text), r1.text);

    const r2 = await send(p, 'Rostock');
    check('S13 a bare city answer is accepted', REPLY.askRequest.test(r2.text), r2.text);

    await send(p, 'I need new work clothes in size L please');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S13 the name given earlier is not lost',
      row && row.station === 'VOI Rostock' && row.firstName === 'Diana' && row.lastName === 'Ionita',
      row ? JSON.stringify({ s: row.station, f: row.firstName, l: row.lastName }) : 'not saved');
  }

  // === Scenario 14: answering the city question with "VOI Berlin" again ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    await send(p, 'Qays VOI');
    const r = await send(p, 'VOI Schwerin');
    check('S14 repeating "VOI <city>" at the city step still works',
      REPLY.askRequest.test(r.text), r.text);
    await send(p, 'Question about my payslip for last month');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S14 station stored as VOI Schwerin',
      row && row.station === 'VOI Schwerin', row ? row.station : 'not saved');
  }

  // === Scenario 15: an unknown city still works (no deploy to open a city) ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    const r = await send(p, 'Adil Sefer VOI Lübeck');
    check('S15 an unlisted city is accepted', REPLY.askRequest.test(r.text), r.text);
    await send(p, 'I need a confirmation letter for my landlord');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S15 unlisted city stored title-cased',
      row && row.station === 'VOI Lübeck', row ? row.station : 'not saved');
  }

  // === Scenario 16: Amazon is completely unaffected ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    const r = await send(p, 'John Smith DBE2');
    check('S16 Amazon still accepted unchanged', REPLY.askRequest.test(r.text), r.text);
    // Deliberately not a scanner request — that correctly triggers a follow-up.
    await send(p, 'I need login details for Emietarbeiter please');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S16 Amazon station still written as plain DBE2',
      row && row.station === 'DBE2', row ? row.station : 'not saved');
  }

  // === Scenario 17: each contract sees its own examples ===
  {
    const pA = nextPhone();
    await send(pA, 'Hi');
    const amazon = await send(pA, 'Peter Klein DBE3');

    const pV = nextPhone();
    await send(pV, 'Hi');
    const voi = await send(pV, 'Mehmet Acar VOI Berlin');

    // Both contracts share one question pack: the topics are payroll, documents
    // and vacation, which apply to anyone on the payroll either way.
    const exampleBlock = (text) => (text.match(/Examples:[\s\S]*?\n\n/) || [''])[0];

    check('S17 both contracts are offered the same examples',
      exampleBlock(amazon.text) === exampleBlock(voi.text),
      'amazon=' + JSON.stringify(exampleBlock(amazon.text)) +
      ' voi=' + JSON.stringify(exampleBlock(voi.text)));
    check('S17 the examples are actually present',
      /Lohnabrechnung/i.test(voi.text) && /scanner/i.test(voi.text) &&
      /Emietarbeiter/i.test(voi.text) && /vacation/i.test(voi.text),
      voi.text.slice(0, 300));
    check('S17 each still greets with its own location',
      /DBE3/.test(amazon.text) && /VOI Berlin/.test(voi.text),
      'amazon=' + amazon.text.slice(0, 60) + ' voi=' + voi.text.slice(0, 60));
  }

  // === Scenario 18: a VOI driver who leads with their request ===
  {
    const p = nextPhone();
    await send(p, 'I need my Lohnabrechnung for July, it never arrived');
    await send(p, 'Samir Muranovic VOI');
    const r = await send(p, 'Hamburg');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S18 the opening request survives the extra city step',
      !!row && /Lohnabrechnung/i.test(row.request || '') && row.station === 'VOI Hamburg',
      row ? JSON.stringify({ s: row.station, r: row.request }) : `no row; reply: ${r.text}`);
  }

  // === Scenario 19: a broken item is routed differently per contract ===
  {
    // Amazon: collect it from the office.
    const pA = nextPhone();
    await send(pA, 'Hi');
    await send(pA, 'Peter Klein DBE2');
    const amazonAsk = await send(pA, 'I need a scanner');
    const amazonDone = await send(pA, 'it is broken completely');

    check('S19 Amazon is told to come to the office',
      /come to the office/i.test(amazonAsk.text), amazonAsk.text);
    check('S19 Amazon is not sent to a Team Leader',
      !/team leader/i.test(amazonAsk.text) && !/team leader/i.test(amazonDone.text),
      amazonAsk.text);

    // VOI: go through the Team Leader / Lead Driver.
    const pV = nextPhone();
    await send(pV, 'Hi');
    await send(pV, 'Marta Kowalska VOI Berlin');
    const voiAsk = await send(pV, 'I need a scanner');
    const voiDone = await send(pV, 'it is broken completely');

    check('S19 VOI is sent to their Team Leader / Lead Driver',
      /Team Leader \/ Lead Driver/i.test(voiAsk.text), voiAsk.text);
    check('S19 VOI is never told to come to the office',
      !/come to the office/i.test(voiAsk.text) && !/come to the office/i.test(voiDone.text),
      voiAsk.text + ' || ' + voiDone.text);

    // And the instruction is repeated on the confirmation, per contract.
    check('S19 the confirmation carries the right instruction for each',
      /come to the office/i.test(amazonDone.text) && /Team Leader/i.test(voiDone.text),
      'amazon=' + amazonDone.text.slice(0, 160) + ' || voi=' + voiDone.text.slice(0, 160));

    // Both still reach the sheet.
    const rowA = saved.find((s) => s.phoneNumber === pA);
    const rowV = saved.find((s) => s.phoneNumber === pV);
    check('S19 both broken-item requests still get saved',
      !!rowA && !!rowV && rowA.station === 'DBE2' && rowV.station === 'VOI Berlin',
      JSON.stringify({ a: rowA && rowA.station, v: rowV && rowV.station }));
  }

  // === Scenario 20: VOI drivers give their city, never the word "VOI" ===
  {
    for (const [label, msg, expect] of [
      ['city only',        'Marta Kowalska Berlin',  { station: 'VOI Berlin',  first: 'Marta',  last: 'Kowalska' }],
      ['lowercase city',   'jonas lindqvist hamburg', { station: 'VOI Hamburg', first: 'jonas',  last: 'lindqvist' }],
      ['city first',       'Kiel Tomasz Nowak',      { station: 'VOI Kiel',    first: 'Tomasz', last: 'Nowak' }],
      ['three-part name',  'Aisha Marie Diallo Rostock', { station: 'VOI Rostock', first: 'Aisha', last: 'Marie Diallo' }],
    ]) {
      const p = nextPhone();
      await send(p, 'Hi');
      const r = await send(p, msg);
      if (!REPLY.askRequest.test(r.text)) {
        check(`S20 ${label} accepted`, false, r.text);
        continue;
      }
      await send(p, 'I need my Lohnabrechnung for this month please');
      const row = saved.find((s) => s.phoneNumber === p);
      check(`S20 ${label} -> ${expect.station}`,
        row && row.station === expect.station && row.firstName === expect.first && row.lastName === expect.last,
        row ? JSON.stringify({ s: row.station, f: row.firstName, l: row.lastName }) : 'not saved');
    }
  }

  // === Scenario 21: nobody is asked to choose between Amazon and VOI ===
  {
    const p = nextPhone();
    const welcome = await send(p, 'Hi');
    check('S21 the welcome does not brand a choice between the two',
      !/Amazon:/i.test(welcome.text) && !/VOI:/i.test(welcome.text) && !/🛴/.test(welcome.text),
      welcome.text);
    check('S21 the welcome still shows both shapes of answer',
      /DBE2/.test(welcome.text) && /Berlin/.test(welcome.text), welcome.text);

    const reprompt = await send(p, 'just my name');
    check('S21 the re-prompt does not brand a choice either',
      !/Amazon:/i.test(reprompt.text) && !/VOI:/i.test(reprompt.text), reprompt.text);
  }

  // === Scenario 22: writing "VOI Berlin" still works for anyone used to it ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    const r = await send(p, 'Sofia Ruiz VOI Schwerin');
    check('S22 the explicit "VOI <city>" form still works', REPLY.askRequest.test(r.text), r.text);
    await send(p, 'I need a confirmation letter for my landlord');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S22 stored the same way either form is used',
      row && row.station === 'VOI Schwerin', row ? row.station : 'not saved');
  }

  // === Scenario 23: a city typo without "VOI" is not guessed at ===
  {
    // Fuzzy matching only applies when VOI is written explicitly — otherwise a
    // near-miss is more likely to be a surname than a typo.
    const p = nextPhone();
    await send(p, 'Hi');
    const r = await send(p, 'Lena Bergmann Berlim');
    check('S23 a misspelled city with no VOI is re-asked, not assumed',
      REPLY.askAgain.test(r.text) && !REPLY.askRequest.test(r.text), r.text);

    const p2 = nextPhone();
    await send(p2, 'Hi');
    const r2 = await send(p2, 'Lena Bergmann VOI Berlim');
    check('S23 the same typo with VOI written is corrected', REPLY.askRequest.test(r2.text), r2.text);
    await send(p2, 'I need my payslip for last month please');
    const row = saved.find((s) => s.phoneNumber === p2);
    check('S23 corrected to VOI Berlin', row && row.station === 'VOI Berlin',
      row ? row.station : 'not saved');
  }

  // === Scenario 24: Amazon wins when both appear ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    await send(p, 'Ahmed Hassan DBE3 Berlin');
    await send(p, 'I need login details for the portal please');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S24 a station beats a city name in the same message',
      row && row.station === 'DBE3', row ? row.station : 'not saved');
  }

  // === Scenario 25: a station typed with a space is still Amazon ===
  // Regression: "Muhammad junaid Rashid DBE 3 Berlin" was filed as VOI Berlin.
  // DBE2/DBE3 are Berlin stations, so a city name is NOT evidence of contract.
  {
    for (const [label, msg, station, name] of [
      ['space in station',      'Muhammad Junaid DBE 3',          'DBE3', 'Muhammad Junaid'],
      ['space + city',          'Muhammad Junaid DBE 3 Berlin',   'DBE3', 'Muhammad Junaid'],
      ['hyphen in station',     'Peter Klein DBE-2',              'DBE2', 'Peter Klein'],
      ['lowercase with space',  'anna meier dbe 3',               'DBE3', 'anna meier'],
      ['station and city',      'Harnoor Singh DBE3 Berlin',      'DBE3', 'Harnoor Singh'],
      ['city before station',   'Nils Weber Hamburg DBE2',        'DBE2', 'Nils Weber'],
    ]) {
      const p = nextPhone();
      await send(p, 'Hi');
      const r = await send(p, msg);
      if (!REPLY.askRequest.test(r.text)) {
        check(`S25 ${label} accepted`, false, r.text);
        continue;
      }
      await send(p, 'I need login details for the portal please');
      const row = saved.find((s) => s.phoneNumber === p);
      check(`S25 ${label} -> ${station}`,
        row && row.station === station, row ? row.station : 'not saved');
      check(`S25 ${label} keeps the city out of the name`,
        row && (row.firstName + ' ' + row.lastName) === name,
        row ? row.firstName + ' ' + row.lastName : 'not saved');
    }
  }

  // === Scenario 26: an unreadable station is re-asked, never guessed as VOI ===
  {
    const p = nextPhone();
    await send(p, 'Hi');
    const r = await send(p, 'Peter Klein DBE Berlin');
    check('S26 a broken station is not silently filed as VOI',
      /could not read your station/i.test(r.text) && !REPLY.askRequest.test(r.text), r.text);

    const r2 = await send(p, 'Peter Klein DBE2');
    check('S26 and the correction is accepted', REPLY.askRequest.test(r2.text), r2.text);
    await send(p, 'I need login details for the portal please');
    const row = saved.find((s) => s.phoneNumber === p);
    check('S26 stored as Amazon', row && row.station === 'DBE2', row ? row.station : 'not saved');
  }

  // === Scenario 27: HELP, CANCEL and START OVER work at any step ===
  {
    const p = nextPhone();
    const helpFirst = await send(p, 'HELP');
    check('S27 HELP before a conversation explains how to start',
      /first name/i.test(helpFirst.text) && /CANCEL/i.test(helpFirst.text) && /START OVER/i.test(helpFirst.text),
      helpFirst.text);

    await send(p, 'Hi');
    await send(p, 'Maria Garcia DBE2');
    const helpMid = await send(p, 'hilfe!');
    check('S27 HELP during the request step does not file the word help',
      /what you need help with/i.test(helpMid.text) && !/submitted successfully/i.test(helpMid.text),
      helpMid.text);

    const cancelled = await send(p, 'CANCEL');
    check('S27 CANCEL stops without sending anything',
      /nothing was sent/i.test(cancelled.text), cancelled.text);

    const afterCancel = await send(p, 'I need a new scanner because mine stopped working');
    check('S27 a request after CANCEL is held, not filed under the old name',
      /who you are/i.test(afterCancel.text) && !/submitted successfully/i.test(afterCancel.text),
      afterCancel.text);

    const restarted = await send(p, 'START OVER');
    check('S27 START OVER begins again at the welcome',
      REPLY.welcome.test(restarted.text) && /John Smith DBE2/.test(restarted.text),
      restarted.text);
  }

  // ---- summary ----
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write(`\nFAILED:\n${failed.map((f) => ' - ' + f.name).join('\n')}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
