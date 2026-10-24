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
  // The option list is visible body text, not only button payload: when a
  // handset does not render the native-flow controls the user still sees the
  // media information and a working numbered reply instead of a bare
  // "Choose a format" status line.
  // Numbered options keep their number; named actions ("Try again") are shown
  // as bullets so the body never reads "retry. Try again".
  const numbered = actions.some(action => /^\d+$/.test(String(action.value)));
  const optionLines = actions.map(action => {
    const detail = action.description ? ` — ${action.description}` : '';
    return /^\d+$/.test(String(action.value)) ? `${action.value}. ${action.label}${detail}` : `• ${action.label}${detail}`;
  }).join('\n');
  const hint = numbered ? 'Reply with a number, or use the options above.' : 'Use the options above.';
  const body = `${text}\n\n${optionLines}\n\n${hint}`;
  const base = { text: body, footer: 'ANIME MD • Only you can use this selection', quoted: ctx.raw };
  // A thumbnail upload can fail independently of the controls; retry the SAME
  // native buttons without the image instead of dropping to plain text.
  const relay = (flowButtons, withImage = true) => relayInteractive(socket, ctx.chatId, { ...base, image: withImage ? image : undefined, buttons: flowButtons });
  if (mode === 'auto' && !list && buttons.length <= 3) {
    try { return { message: await relay(buttons), native: true }; }
    catch { log('QUICK_REPLY_UNAVAILABLE', 'interface'); }
  }
  try { if (mode !== 'text') return { message: await relay([single]), native: true }; }
  catch { log('NATIVE_LIST_UNAVAILABLE', 'interface'); }
  // Media preparation can fail independently of interactive transport. Keep
  // real native controls with an explicit thumbnail warning in that case.
  if (image && mode !== 'text') {
    try { return { message: await relayInteractive(socket, ctx.chatId, { ...base, text: `${body}\n\nThumbnail unavailable.`, buttons: list || mode === 'list' ? [single] : buttons }), native: true }; }
    catch { log('TEXT_NATIVE_UNAVAILABLE', 'interface'); }
  }
  const compatibility = mode === 'text' ? 'Text selection mode.' : 'Buttons are unavailable on this connection.';
  const reply = numbered ? 'Reply to this message with an option number.' : 'Reply to this message with “retry” to try again' + (actions.some(action => action.value === 'sources') ? ' or “sources” to choose another result.' : '.');
  const fallback = `${text}\n\n${optionLines}\n\n${compatibility} ${reply}`;
  const sendOptions = { quoted: ctx.raw, mediaUploadTimeoutMs: 10000 };
  let message;
  if (image) {
    try { message = await socket.sendMessage(ctx.chatId, { image, caption: fallback }, sendOptions); }
    catch { log('THUMBNAIL_SEND_FAILED', 'interface'); }
  }
  message ||= await socket.sendMessage(ctx.chatId, { text: `${fallback}${image ? '\nThumbnail unavailable.' : ''}` }, sendOptions);
  return { message, native: false };
}
module.exports = { selection };
