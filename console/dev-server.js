/**
 * Demo server — runs the console against an in-memory sheet.
 *
 * No Google credentials, no network, nothing written to the real spreadsheet.
 * Use it to look at the UI, or to try the triage and activity flows safely.
 *
 *   node console/dev-server.js
 *   → http://localhost:4100   access code: demo
 */

process.env.CONSOLE_ACCESS_CODE = process.env.CONSOLE_ACCESS_CODE || 'demo';
// The demo polls every 15s rather than production's 300s, so a simulated arrival
// can actually be watched turning up.
process.env.CONSOLE_POLL_SECONDS = process.env.CONSOLE_POLL_SECONDS || '15';
process.env.PORT = process.env.PORT || '4100';
process.env.GOOGLE_SHEET_ID = 'DEMO-SHEET';

const path = require('path');
const { FakeSheets } = require('./tests/fake_sheets');
const { SheetsClient, ACTIVITY_HEADERS } = require('./lib/sheets');
const { Repository } = require('./lib/repository');

// ---- a sheet that looks like the real one -------------------------------

const HEADER = [
  'Timestamp', 'First Name', 'Last Name', 'Station', 'Request/Question',
  'Request ID', 'Phone Number', 'Status', 'Owner', 'Priority', 'DA Contacted',
  'Out or still with us', 'Action', 'Notes', 'Category', 'Completed At'
];

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const pad = (v) => String(v).padStart(2, '0');
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
    ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

const ROWS = [
  [daysAgo(0), 'Yogeshkumar', 'Savaliya', 'DBE3', '4.1.1 Actual Jobcontract.\n\n4.1.2 Actual confirmation of employer "über ein unbefristetes, bestehendes und ungekündigtes Arbeitsverhältnis".\n\n4.1.4 Attached Form "Erklärung zum Beschäftigungsverhältnis", filled out by your employer', 'REQ-2001', 'whatsapp:+4917630672255', 'To be contacted', '', '', '', '', '', ''],
  [daysAgo(2), 'Florent', 'Krasniqi', 'DBE2', 'I need a new scanner because mine stopped working yesterday morning', 'REQ-2002', 'whatsapp:+4917600000102', 'To be contacted', '', '', '', '', '', ''],
  [daysAgo(5), 'Maria', 'Garcia', 'DBE2', 'I want to change my IBAN to DE12 5001 0517 0648 4898 90 because I opened a new bank account', 'REQ-2003', 'whatsapp:+4917600000103', 'In Progress', 'Boris', 'High', 'Phone', '', '', ''],
  [daysAgo(9), 'Ahmed', 'Hassan', 'DBE3', 'I need login details for Emietarbeiter, I cannot access the portal', 'REQ-2004', 'whatsapp:+4917600000104', 'To be contacted', 'Diana Ionita', 'Normal', '', '', '', ''],
  [daysAgo(14), 'Nina', 'Braun', 'DBE2', 'Can I request vacation from 15.09.2026 to 22.09.2026?', 'REQ-2005', 'whatsapp:+4917600000105', 'needs to be clarified', '', '', '', '', '', ''],
  [daysAgo(26), 'Luis', 'Ferreira', 'DBE3', 'My delivery route shows the wrong address for a customer in Prenzlauer Berg', 'REQ-2006', 'whatsapp:+4917600000106', 'To be contacted', '', '', '', '', '', ''],
  [daysAgo(31), 'Samir', 'Osmani', 'DBE3', 'I need my Lohnabrechnung for last month, it never arrived', 'REQ-2007', 'whatsapp:+4917600000103', 'Not started', '', '', '', '', '', ''],
  [daysAgo(40), 'Petra', 'Novak', 'DBE2', 'Scanner has GPS problems, it keeps losing the signal on my route', 'REQ-2008', 'whatsapp:+4917600000108', 'To be contacted', 'Pedro Trabbold', 'Urgent', 'WhatsApp', '', '', ''],
  [daysAgo(3), 'Elena', 'Petrova', 'DBE3', 'Please confirm my contract end date for my landlord', 'REQ-2009', 'whatsapp:+4917600000109', 'Completed', 'Amnery', '', '', '', '', '', daysAgo(1)],
  [daysAgo(12), 'Tomas', 'Weber', 'DBE2', 'I lost my work phone charger, can I get a replacement?', 'REQ-2010', 'whatsapp:+4917600000110', 'Completed', 'Hugo', '', '', '', '', '', ''],
  [daysAgo(20), 'Ana', 'Silva', 'DBE3', 'Question about my payslip amount this month, it looks lower than usual', 'REQ-2011', 'whatsapp:+4917600000111', 'Completed', 'Fadi', '', '', '', '', '', ''],
  [daysAgo(8), 'Ibrahim', 'Kone', 'DBE2', 'Need a confirmation letter for my visa appointment next week', 'REQ-2012', 'whatsapp:+4917600000102', 'To be contacted', '', '', '', '', '', ''],

  // VOI — the station cell carries the city, and these default to Anderson.
  [daysAgo(1), 'Marta', 'Kowalska', 'VOI Berlin', 'I need my Lohnabrechnung for July, it did not arrive', 'REQ-2013', 'whatsapp:+4917600000201', 'To be contacted', '', '', '', '', '', ''],
  [daysAgo(6), 'Jonas', 'Lindqvist', 'VOI Hamburg', 'I want to change my IBAN, I opened a new bank account', 'REQ-2014', 'whatsapp:+4917600000202', 'To be contacted', 'Anderson Meta', 'Normal', '', '', '', ''],
  [daysAgo(17), 'Aisha', 'Diallo', 'VOI Berlin', 'Can I request vacation from 01.10.2026 to 08.10.2026?', 'REQ-2015', 'whatsapp:+4917600000203', 'needs to be clarified', '', '', '', '', '', ''],
  [daysAgo(4), 'Tomasz', 'Nowak', 'VOI Kiel', 'I need new work clothes in size L please', 'REQ-2016', 'whatsapp:+4917600000204', 'To be contacted', '', '', '', '', '', ''],
  [daysAgo(23), 'Sofia', 'Ruiz', 'VOI Rostock', 'Question about my contract end date for my landlord', 'REQ-2017', 'whatsapp:+4917600000205', 'Completed', 'Anderson Meta', '', '', '', '', '', '']
];

const DEMO_CATEGORIES = [
  'Documents', 'Scanner', 'Bank details', 'Documents', 'Vacation', 'Equipment',
  'Payroll', 'Scanner', 'Contract', 'Equipment', 'Payroll', 'Documents',
  'Payroll', 'Bank details', 'Vacation', 'Equipment', 'Contract'
];
// Open rows stop at Notes (14 cells). Completed rows already include Completed At
// (15 cells). Pad, then insert Category in front of Completed At so it lands on
// the header — splicing before "whatever is last" put the label in Notes.
ROWS.forEach(function (row, i) {
  if (row.length === 14) row.push('');
  row.splice(14, 0, DEMO_CATEGORIES[i] || '');
});

const fake = new FakeSheets({
  'Driver Requests': [HEADER].concat(ROWS),
  'Activity Log': [
    ACTIVITY_HEADERS.slice(),
    [new Date(Date.now() - 3600000).toISOString(), 'REQ-2003', 'Boris Toma', 'Admin', 'Called the driver, waiting for the new IBAN confirmation.'],
    [new Date(Date.now() - 1800000).toISOString(), 'REQ-2003', 'Boris Toma', 'Admin', 'Payroll notified.']
  ]
});

// ---- wire the demo client into the real server --------------------------

const client = new SheetsClient({
  spreadsheetId: 'DEMO-SHEET',
  fetchImpl: fake.fetch,
  tokenProvider: async () => 'demo-token'
});

const app = require('./server');

// Swap the repository's sheets client for the fake one.
app.repo.sheets = client;
app.repo.cacheMs = 0;
app.repo.invalidate();

// Demo-only: pretend a driver just sent a request, so the new-arrival chip,
// the NEW tag and the tab badge can be seen working. Never reaches production —
// this route only exists in dev-server.js.
let demoSeq = 0;
app.app.post('/demo/new-request', (req, res) => {
  demoSeq++;
  const names = [['Nadir', 'Timur', 'DBE2'], ['Diana', 'Ionita', 'DBE3'], ['Adil', 'Sefer', 'DBE2']];
  const who = names[demoSeq % names.length];
  const texts = [
    'My scanner will not charge, I need a replacement before tomorrow',
    'I need my Lohnabrechnung for this month, it did not arrive',
    'Can I request vacation from 01.10.2026 to 08.10.2026?'
  ];

  fake.tabs['Driver Requests'].push([
    daysAgo(0), who[0], who[1], who[2], texts[demoSeq % texts.length],
    'REQ-DEMO-' + Date.now(), 'whatsapp:+49176000009' + demoSeq,
    'To be contacted', '', '', '', '', '', '', ''
  ]);

  app.repo.invalidate();
  res.json({ ok: true, added: 1, total: fake.tabs['Driver Requests'].length - 1 });
});

app.app.listen(process.env.PORT, () => {
  console.log('='.repeat(60));
  console.log('🧪 Driver Requests Console — DEMO (in-memory sheet)');
  console.log('   http://localhost:' + process.env.PORT);
  console.log('   access code: ' + process.env.CONSOLE_ACCESS_CODE);
  console.log('');
  console.log('   Nothing here touches the real spreadsheet.');
  console.log('='.repeat(60));
});
