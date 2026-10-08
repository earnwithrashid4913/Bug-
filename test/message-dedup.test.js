'use strict';

// ---------------------------------------------------------------------------
// Bounded message deduplication (system/lib/message-dedup.js).
//
// The same incoming message must be processed exactly once — duplicate
// deliveries (retries, reconnect replay) must never become duplicate replies.
// The cache is bounded, so this protection stays low-RAM safe.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const dedup = require('../system/lib/message-dedup');

test('a re-delivered message id is processed exactly once', () => {
  const socket = {};
  assert.equal(dedup.isDuplicate(socket, 'chat@g.us', 'MSG1'), false, 'first delivery is processed');
  assert.equal(dedup.isDuplicate(socket, 'chat@g.us', 'MSG1'), true, 're-delivery is ignored');
  assert.equal(dedup.isDuplicate(socket, 'chat@g.us', 'MSG1'), true, 'kept while still fresh');
});

test('different ids, different chats and different sockets are independent', () => {
  const a = {}, b = {};
  assert.equal(dedup.isDuplicate(a, 'chat@g.us', 'MSG2'), false);
  assert.equal(dedup.isDuplicate(a, 'other@g.us', 'MSG2'), false, 'same id in another chat is another message');
  assert.equal(dedup.isDuplicate(b, 'chat@g.us', 'MSG2'), false, 'sockets are isolated');
  assert.equal(dedup.isDuplicate(a, 'chat@g.us', 'MSG3'), false);
});

test('messages without an id are never deduplicated', () => {
  const socket = {};
  assert.equal(dedup.isDuplicate(socket, 'chat@g.us', undefined), false);
  assert.equal(dedup.isDuplicate(socket, 'chat@g.us', null), false);
});

test('the cache is bounded: oldest ids are evicted past the cap', () => {
  const socket = {};
  for (let i = 0; i < dedup.MAX_ENTRIES + 50; i++) {
    assert.equal(dedup.isDuplicate(socket, 'chat@g.us', `ID${i}`), false);
  }
  assert.ok(dedup.size(socket) <= dedup.MAX_ENTRIES, `size ${dedup.size(socket)} exceeds the cap`);
  assert.equal(dedup.isDuplicate(socket, 'chat@g.us', 'ID0'), false, 'the oldest entry was evicted');
  assert.equal(dedup.isDuplicate(socket, 'chat@g.us', `ID${dedup.MAX_ENTRIES + 49}`), true, 'recent entries survive');
});

test('clear(socket) drops only that socket\'s cache', () => {
  const a = {}, b = {};
  dedup.isDuplicate(a, 'c', 'X');
  dedup.isDuplicate(b, 'c', 'X');
  dedup.clear(a);
  assert.equal(dedup.size(a), 0);
  assert.equal(dedup.isDuplicate(b, 'c', 'X'), true, 'other sockets are untouched');
});
