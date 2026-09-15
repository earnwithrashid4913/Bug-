'use strict';

// ---------------------------------------------------------------------------
// ExecuteAfter — integration scenario runner (test support only).
//
// Loaded in a CHILD process (each child gets its own ExecuteAfter config through
// EXECUTE_AFTER_CONFIG) and drives the real AnimeMD handler with a fake socket,
// so command routing, provider requests, formatting, media delivery and error
// isolation are exercised end to end.
//
// The report is written to EXECUTE_AFTER_REPORT as JSON:
//   { steps: [{ step, error, media: [{ kind, mimetype, source }],
//               reactions: [string], text: string }] }
// ---------------------------------------------------------------------------

const fs = require('node:fs');

// Collects every human-visible string out of a chat payload (plain text,
// caption, interactive body/footer, list rows, quick buttons, relayed proto
// messages). Collecting the WHOLE payload on purpose: assertions can then prove
// that no technical detail, `undefined` or `NaN` leaks anywhere in the message.
function collectText(node, out, depth = 0) {
  if (node === null || node === undefined || depth > 8) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Buffer.isBuffer(node) || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out, depth + 1);
    return;
  }
  for (const value of Object.values(node)) collectText(value, out, depth + 1);
}

function replyOf(payload) {
  if (payload === null || payload === undefined) return '';
  const parts = [];
  collectText(payload, parts);
  return parts.join('\n').normalize('NFKC');
}

function mediaOf(payload) {
  for (const key of ['video', 'audio', 'image', 'document']) {
    if (payload?.[key] === undefined) continue;
    return {
      kind: key,
      mimetype: payload.mimetype || '',
      source: Buffer.isBuffer(payload[key]) ? 'buffer' : typeof payload[key]?.pipe === 'function' ? 'stream' : 'other'
    };
  }
  return null;
}

function reactionOf(payload) {
  if (typeof payload?.react?.text === 'string') return payload.react.text;
  if (typeof payload?.reactionMessage?.text === 'string') return payload.reactionMessage.text;
  return '';
}

const DEFAULT_CHAT = '15550000001@s.whatsapp.net';

// Every payload is recorded with the chat it was sent to, so parallel steps in
// different chats can be attributed without guessing.
async function run(scenario = {}) {
  const handler = require('../system/handler');
  const sent = [];
  const socket = {
    decodeJid: (jid) => String(jid).replace(/:\d+@/, '@'),
    groupMetadata: async () => ({ participants: [], subject: 'Scenario' }),
    public: true,
    relayMessage: async (jid, message) => { sent.push({ jid: String(jid), payload: { interactive: message } }); return 'relayed'; },
    sendMessage: async (jid, payload) => { sent.push({ jid: String(jid), payload }); return { key: { id: 'scenario' } }; },
    sendPresenceUpdate: async () => {},
    user: { id: DEFAULT_CHAT, name: 'Scenario Owner' }
  };

  let serial = 0;
  const message = (text, jid) => ({
    key: { fromMe: true, id: `scenario-${++serial}`, participant: jid, remoteJid: jid },
    message: { conversation: text },
    pushName: 'Scenario Owner'
  });

  // Payloads are consumed per chat, so repeated commands in the same chat still
  // get their own slice while parallel steps in different chats stay separated.
  const consumed = new Map();
  const payloadsFor = (jid) => {
    const mine = sent.filter((record) => record.jid === jid).map((record) => record.payload);
    const start = consumed.get(jid) || 0;
    consumed.set(jid, mine.length);
    return mine.slice(start);
  };

  const steps = [];
  const runStep = async (spec) => {
    const text = typeof spec === 'string' ? spec : String(spec?.text || '');
    const chat = typeof spec === 'object' && spec?.chat ? String(spec.chat) : DEFAULT_CHAT;
    let error = '';
    try {
      await handler(socket, message(text, chat));
    } catch (caught) {
      error = `${caught?.name || 'Error'}: ${caught?.message || caught}`;
    }
    const payloads = payloadsFor(chat);
    const entry = {
      chat,
      error,
      media: payloads.map(mediaOf).filter(Boolean),
      reactions: payloads.map(reactionOf).filter(Boolean),
      text: payloads.map(replyOf).filter(Boolean).join('\n')
    };
    steps.push({ step: text, ...entry });
    return entry;
  };

  for (const step of scenario.steps || []) {
    if (typeof step === 'string' || step?.text) {
      await runStep(step);
      continue;
    }
    if (step.parallel) {
      // Fire several commands at once to exercise the concurrency guards. Each
      // branch must use its own chat: two branches in one chat cannot be told
      // apart reliably once their payloads interleave.
      const chats = step.parallel.map((branch) => (typeof branch === 'object' && branch?.chat) || DEFAULT_CHAT);
      if (new Set(chats).size !== chats.length) {
        throw new Error('parallel scenario steps must each use a different chat');
      }
      await Promise.all(step.parallel.map((branch) => runStep(branch)));
      continue;
    }
  }

  return steps;
}

function writeReport(payload) {
  if (!process.env.EXECUTE_AFTER_REPORT) return;
  try {
    fs.writeFileSync(process.env.EXECUTE_AFTER_REPORT, JSON.stringify(payload));
  } catch (error) {
    console.error(`[execute-after:scenario] could not write the report: ${error.message}`);
  }
}

// A ref'd keep-alive timer: the child must never be allowed to exit while a
// scenario step is still in flight, whatever the framework does internally.
function keepAlive() {
  return setInterval(() => {}, 1000);
}

async function main() {
  const heartbeat = keepAlive();
  const timeoutMs = Math.max(1000, Number(process.env.EXECUTE_AFTER_SCENARIO_TIMEOUT_MS) || 45000);
  let timer = null;
  try {
    const scenario = JSON.parse(process.env.EXECUTE_AFTER_SCENARIO || '{"steps":[]}');
    const steps = await Promise.race([
      run(scenario),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
    if (steps === null) {
      writeReport({ fatal: `scenario timed out after ${timeoutMs}ms` });
      process.exitCode = 1;
      return;
    }
    writeReport({ steps });
  } catch (error) {
    writeReport({ fatal: String(error?.stack || error) });
    process.exitCode = 1;
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(heartbeat);
  }
}

if (require.main === module || !module.parent) main();

module.exports = { main, run };
