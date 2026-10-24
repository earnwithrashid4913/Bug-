'use strict';

// Reuse the bot's installed Baileys native-flow implementation. A server relay
// acknowledgment is not proof of rendering on a handset; both native callback
// shapes are handled by message.js and revision-checked by youtube-flow.js.
const { config } = require('../config');
const { relayInteractive, quickButton, listButton } = require('./ui');

async function selection(socket, ctx, { text, image, actions, token, revision, list = false, mode = config.downloadsInteractiveMode, log = () => {} }) {
  const id = value => `yt:${token}:${revision}:${value}`;
  const buttons = actions.map(action => quickButton(action.label, id(action.value)));
  const single = listButton('Choose an option', [{ title: 'ANIME MD', rows: actions.map(action => ({ title: action.label, description: action.description || '', id: id(action.value) })) }]);
  const base = { text, footer: 'ANIME MD • Only you can use this selection', quoted: ctx.raw };
  const relay = flowButtons => relayInteractive(socket, ctx.chatId, { ...base, image, buttons: flowButtons });
  if (mode === 'auto' && !list && buttons.length <= 3) {
    try { return { message: await relay(buttons), native: true }; }
    catch { log('QUICK_REPLY_UNAVAILABLE', 'interface'); }
  }
  try { if (mode !== 'text') return { message: await relay([single]), native: true }; }
  catch { log('NATIVE_LIST_UNAVAILABLE', 'interface'); }
  // Media preparation can fail independently of interactive transport. Keep
  // real native controls with an explicit thumbnail warning in that case.
  if (image && mode !== 'text') {
    try { return { message: await relayInteractive(socket, ctx.chatId, { ...base, text: `${text}\nThumbnail unavailable.`, buttons: list || mode === 'list' ? [single] : buttons }), native: true }; }
    catch { log('TEXT_NATIVE_UNAVAILABLE', 'interface'); }
  }
  const compatibility = mode === 'text' ? 'Text selection mode.' : 'Buttons are unavailable on this connection.';
  const fallback = `${text}\n\n${actions.map(action => `${action.value}. ${action.label}`).join('\n')}\n\n${compatibility} Reply to this message with an option, or send ${token} ${(actions.find(action => action.value === '2') || actions[0]).value}.`;
  const options = { quoted: ctx.raw, mediaUploadTimeoutMs: 10000 };
  let message;
  if (image) {
    try { message = await socket.sendMessage(ctx.chatId, { image, caption: fallback }, options); }
    catch { log('THUMBNAIL_SEND_FAILED', 'interface'); }
  }
  message ||= await socket.sendMessage(ctx.chatId, { text: `${fallback}${image ? '\nThumbnail unavailable.' : ''}` }, options);
  return { message, native: false };
}
module.exports = { selection };
