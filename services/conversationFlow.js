const fs = require('fs');
const path = require('path');

function resolveStorePath() {
  if (process.env.FLOW_STORE === 'memory' || process.env.FLOW_STORE === '0') return null;
  if (process.env.FLOW_STORE) return process.env.FLOW_STORE;
  return path.join(__dirname, '..', 'data', 'conversation-flows.json');
}

// Conversation state. Persisted to disk so a process restart does not send a
// driver who has already given their name back to the welcome message.
class ConversationFlow {
  constructor(options) {
    this.flows = new Map();
    this.userInfo = new Map();
    this.flowExpiry = 30 * 60 * 1000; // 30 minutes
    this.storePath = options && Object.prototype.hasOwnProperty.call(options, 'storePath')
      ? options.storePath
      : resolveStorePath();

    this.load();

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredFlows();
    }, 10 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  load() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    } catch (error) {
      console.error('Could not load conversation flows:', error.message);
      return;
    }

    const now = Date.now();
    let dropped = false;
    (payload.flows || []).forEach((entry) => {
      const phone = entry && entry[0];
      const flow = entry && entry[1];
      if (!phone || !flow) return;
      if (now - flow.lastActivity > this.flowExpiry) {
        dropped = true;
        return;
      }
      this.flows.set(phone, flow);
    });
    (payload.userInfo || []).forEach((entry) => {
      if (entry && entry[0]) this.userInfo.set(entry[0], entry[1]);
    });

    if (dropped) this.persist();
    if (this.flows.size > 0) {
      console.log(`💾 Restored ${this.flows.size} conversation${this.flows.size === 1 ? '' : 's'} from disk`);
    }
  }

  persist() {
    if (!this.storePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const payload = JSON.stringify({
        flows: Array.from(this.flows.entries()),
        userInfo: Array.from(this.userInfo.entries())
      });
      const tmp = this.storePath + '.tmp';
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.storePath);
    } catch (error) {
      console.error('Could not save conversation flows:', error.message);
    }
  }

  cleanupExpiredFlows() {
    const now = Date.now();
    let cleaned = 0;
    for (const [phoneNumber, flow] of this.flows.entries()) {
      if (now - flow.lastActivity > this.flowExpiry) {
        this.flows.delete(phoneNumber);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.persist();
      console.log(`🧹 Cleanup: removed ${cleaned} expired flows (${this.flows.size} active remaining)`);
    }
  }

  startFlow(phoneNumber, data) {
    this.flows.set(phoneNumber, {
      ...data,
      startedAt: Date.now(),
      lastActivity: Date.now()
    });
    this.persist();

    console.log(`📱 Started flow for ${phoneNumber}:`, data);
  }

  updateFlow(phoneNumber, data) {
    const existingFlow = this.flows.get(phoneNumber);
    if (existingFlow) {
      this.flows.set(phoneNumber, {
        ...existingFlow,
        ...data,
        lastActivity: Date.now()
      });
      this.persist();

      console.log(`📱 Updated flow for ${phoneNumber}:`, data);
    }
  }

  getFlowState(phoneNumber) {
    const flow = this.flows.get(phoneNumber);

    if (!flow) {
      return null;
    }

    if (Date.now() - flow.lastActivity > this.flowExpiry) {
      console.log(`⏰ Flow expired for ${phoneNumber}`);
      this.flows.delete(phoneNumber);
      this.persist();
      return null;
    }

    return flow;
  }

  clearFlow(phoneNumber) {
    if (this.flows.has(phoneNumber)) {
      console.log(`🧹 Cleared flow for ${phoneNumber}`);
      this.flows.delete(phoneNumber);
      this.persist();
    }
  }

  clearAllFlows() {
    console.log(`🧹 Cleared all flows (${this.flows.size} active)`);
    this.flows.clear();
    this.persist();
  }

  getActiveFlowsCount() {
    return this.flows.size;
  }

  getFlowSummary() {
    const summary = {};
    for (const [phone, flow] of this.flows.entries()) {
      summary[phone] = {
        flow: flow.flow || 'unknown',
        step: flow.step || 'unknown',
        category: flow.category || 'none',
        startedAt: new Date(flow.startedAt).toISOString(),
        lastActivity: new Date(flow.lastActivity).toISOString()
      };
    }
    return summary;
  }

  getRecentMessages(phoneNumber) {
    return null;
  }

  getTimeSinceLastActivity(phoneNumber) {
    const flow = this.flows.get(phoneNumber);
    if (flow) {
      return Date.now() - flow.lastActivity;
    }
    return null;
  }

  storeUserInfo(phoneNumber, userData) {
    this.userInfo.set(phoneNumber, {
      ...userData,
      storedAt: Date.now()
    });
    this.persist();
    console.log(`👤 Stored user info for ${phoneNumber}:`, userData);
  }

  getUserInfo(phoneNumber) {
    return this.userInfo.get(phoneNumber);
  }

  clearUserInfo(phoneNumber) {
    if (this.userInfo.has(phoneNumber)) {
      this.userInfo.delete(phoneNumber);
      this.persist();
      console.log(`🧹 Cleared user info for ${phoneNumber}`);
    }
  }
}

const instance = new ConversationFlow();
instance.ConversationFlow = ConversationFlow;
module.exports = instance;
