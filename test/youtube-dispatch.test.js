'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('../test-support/command-harness');
const { extractText } = require('../system/lib/message');
const URL = 'https://youtu.be/dQw4w9WgXcQ?si=keep-query&x=Case';

test('real dispatcher routes play/video selections into file delivery, including native-response decoding', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const [name, choice, media] of [['play', '2', 'audio'], ['video', '1', 'video'], ['song', '3', 'audio']]) {
    const socket = h.socket();
    await h.handler(socket, socket.message(`!${name} ${URL}`));
    const menu = socket.sends.find(entry => /MEDIA SELECT/.test(entry.payload.text || entry.payload.caption || ''));
    assert.ok(menu);
    const token = (menu.payload.text || menu.payload.caption).match(/([a-f0-9]{12}) 2/)[1];
    const response = socket.message(`${token} ${choice}`);
    response.message = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: `${token} ${choice}` }) } } };
    assert.equal(extractText(response.message), `${token} ${choice}`);
    await h.handler(socket, response);
    if (media === 'video') {
      assert.ok(socket.sends.some(entry => /VIDEO QUALITY/.test(entry.payload.text || '')));
      await h.handler(socket, socket.message(`${token} 1`));
    }
    assert.ok(socket.sends.some(entry => entry.payload[media]?.url === '/mock/media'));
    const before = socket.sends.filter(entry => entry.payload[media]).length;
    await h.handler(socket, socket.message(`${token} ${choice}`));
    assert.equal(socket.sends.filter(entry => entry.payload[media]).length, before);
  }
});
test('direct command aliases use the shared actual dispatcher and do not stop at search or reaction', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const [name, media] of [['ytmp3', 'audio'], ['yta', 'audio'], ['ytaudio', 'audio'], ['audio', 'audio'], ['mp3', 'audio'], ['ytmp4', 'video'], ['mp4', 'video']]) {
    const socket = h.socket(); await h.handler(socket, socket.message(`!${name} ${URL}`));
    assert.equal(socket.sends.filter(entry => entry.payload[media]).length, 1, name);
    assert.ok(socket.sends.findIndex(entry => entry.payload[media]) > socket.sends.findIndex(entry => /MEDIA SELECT/.test(entry.payload.text || '')));
  }
});
