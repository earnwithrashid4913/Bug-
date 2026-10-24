'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('../test-support/command-harness');
const { extractText } = require('../system/lib/message');
const URL = 'https://youtu.be/dQw4w9WgXcQ?si=keep-query&x=Case';

test('real dispatcher routes play selections into file delivery, including native-response decoding', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const [name, choice, media] of [['play', '2', 'audio'], ['song', '3', 'audio']]) {
    const socket = h.socket({ interactive: true });
    await h.handler(socket, socket.message(`!${name} ${URL}`));
    const menu = socket.sends.find(entry => entry.payload.interactiveMessage);
    assert.ok(menu);
    assert.match(menu.payload.interactiveMessage.body.text, /AUDIO MP3[\s\S]*VOICE TYPE/, 'both audio options are visible text');
    const buttons = menu.payload.interactiveMessage.nativeFlowMessage.buttons.map(button => JSON.parse(button.buttonParamsJson));
    const id = buttons[Number(choice) - 1].id;
    const response = socket.message(id);
    response.message = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: id }) } } };
    assert.equal(extractText(response.message), id);
    await h.handler(socket, response);
    assert.ok(socket.sends.some(entry => entry.payload[media]?.url === '/mock/media'));
    const before = socket.sends.filter(entry => entry.payload[media]).length;
    await h.handler(socket, socket.message(id));
    assert.equal(socket.sends.filter(entry => entry.payload[media]).length, before);
  }
});
test('!video uses the resolution card in the real dispatcher and never the audio selector', async t => {
  const h = makeHarness(); t.after(() => h.close());
  const socket = h.socket();
  await h.handler(socket, socket.message(`!video ${URL}`));
  const card = socket.sends.find(entry => /VIDEO QUALITY/.test(entry.payload.text || entry.payload.caption || ''));
  assert.ok(card, 'video opens the quality list');
  assert.doesNotMatch(card.payload.text || card.payload.caption, /AUDIO MP3|VOICE TYPE/);
  assert.equal(socket.sends.filter(entry => entry.payload.audio).length, 0, 'no audio is sent for a video request');
  assert.doesNotMatch(card.payload.text || card.payload.caption, /[a-f0-9]{12}/);
  await h.handler(socket, socket.message('1'));
  assert.equal(socket.sends.filter(entry => entry.payload.video?.url === '/mock/media').length, 1);
  await h.handler(socket, socket.message('1'));
  assert.equal(socket.sends.filter(entry => entry.payload.video?.url === '/mock/media').length, 1, 'a repeated tap cannot duplicate the upload');
});
test('direct command aliases use the shared actual dispatcher and do not stop at search or reaction', async t => {
  const h = makeHarness(); t.after(() => h.close());
  for (const [name, media] of [['ytmp3', 'audio'], ['yta', 'audio'], ['ytaudio', 'audio'], ['audio', 'audio'], ['mp3', 'audio'], ['ytmp4', 'video'], ['mp4', 'video']]) {
    const socket = h.socket(); await h.handler(socket, socket.message(`!${name} ${URL}`));
    assert.equal(socket.sends.filter(entry => entry.payload[media]).length, 1, name);
    assert.ok(socket.sends.findIndex(entry => entry.payload[media]) > socket.sends.findIndex(entry => /MEDIA SELECT/.test(entry.payload.text || '')));
  }
});
