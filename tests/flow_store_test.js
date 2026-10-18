/**
 * Half-finished conversations survive a process restart.
 * Run: node tests/flow_store_test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.FLOW_STORE = 'memory';
const { ConversationFlow } = require('../services/conversationFlow');

const file = path.join(os.tmpdir(), 'trel-flows-' + process.pid + '.json');
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    process.stdout.write('✅ ' + name + '\n');
  } catch (error) {
    results.push({ name, pass: false, detail: error.message });
    process.stdout.write('❌ ' + name + '\n     ' + error.message + '\n');
  }
}

check('a name given before a restart is still there', () => {
  const first = new ConversationFlow({ storePath: file });
  first.startFlow('whatsapp:+4917600000999', {
    step: 'request_collection',
    firstName: 'Maria',
    lastName: 'Garcia',
    station: 'DBE2'
  });

  const restarted = new ConversationFlow({ storePath: file });
  const flow = restarted.getFlowState('whatsapp:+4917600000999');
  assert.ok(flow, 'flow was not restored');
  assert.strictEqual(flow.step, 'request_collection');
  assert.strictEqual(flow.firstName, 'Maria');
  assert.strictEqual(flow.station, 'DBE2');
});

check('clearing a flow stays cleared after a restart', () => {
  const live = new ConversationFlow({ storePath: file });
  live.clearFlow('whatsapp:+4917600000999');
  const restarted = new ConversationFlow({ storePath: file });
  assert.strictEqual(restarted.getFlowState('whatsapp:+4917600000999'), null);
});

check('a conversation older than 30 minutes is not restored', () => {
  const live = new ConversationFlow({ storePath: file });
  live.startFlow('whatsapp:+4917600000888', { step: 'data_collection', firstName: 'Ahmed' });
  live.flows.get('whatsapp:+4917600000888').lastActivity = Date.now() - (31 * 60 * 1000);
  live.persist();

  const restarted = new ConversationFlow({ storePath: file });
  assert.strictEqual(restarted.getFlowState('whatsapp:+4917600000888'), null);
});

try { fs.unlinkSync(file); } catch (e) { /* already gone */ }

const failed = results.filter((r) => !r.pass);
process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n');
process.exit(failed.length ? 1 : 0);
