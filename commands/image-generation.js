'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  UNIVERSAL IMAGE GENERATION SYSTEM
//
//    image command
//      ↓
//    command router (this module's handle*Command entry points)
//      ↓
//    image service (generateImage → requestImage)
//      ↓
//    image provider registry (PROVIDERS, grouped by operation)
//      ↓
//    image provider adapter (request → parse → validate → normalize)
//      ↓
//    DavidCyril image API (commands/davidcyril-api.js, the same universal
//                         client the downloaders and movies already use)
//      ↓
//    normalized image result ({ success, type:'image', provider, imageUrl,
//                              buffer, mimeType, prompt, effect, metadata })
//      ↓
//    AnimeMD media sender (socket.sendMessage({ image: buffer }))
//
//  Adding a future image API is incremental: add its endpoint function to
//  commands/davidcyril-api.js, add ONE adapter to PROVIDERS below and it joins
//  the fallback group of its operation automatically. No new dispatcher, no
//  second framework, no change to any other command.
//
//  Fallback only ever happens INSIDE one operation group: a text→image model is
//  never used to answer an image-effect or image→image request.
// ════════════════════════════════════════════════════════════════════════════

const dc = require('./davidcyril-api');
const { FOOTER } = require('../system/lib/presentation');
const { cleanText, publicHttpsUrl } = require('../system/lib/anime-library');
const { downloadRemoteFile, uploadToCatbox } = require('../system/lib/net-tools');
const { getImageMessage, getStickerMessage } = require('../system/lib/message');

// ── operations ─────────────────────────────────────────────────────────────

const OPERATIONS = Object.freeze({
  TEXT_TO_IMAGE: 'TEXT_TO_IMAGE',
  IMAGE_EFFECT: 'IMAGE_EFFECT',
  IMAGE_TO_IMAGE: 'IMAGE_TO_IMAGE'
});

const OPERATION_LABEL = Object.freeze({
  TEXT_TO_IMAGE: 'Text → Image',
  IMAGE_EFFECT: 'Image Effect',
  IMAGE_TO_IMAGE: 'Image → Image'
});

// ── bounded limits (never infinite, never unbounded) ───────────────────────

const MAX_PROMPT_LENGTH = 600;
const MAX_EFFECT_TEXT_LENGTH = 120;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MIN_IMAGE_BYTES = 512;
const REQUEST_COOLDOWN_MS = 12_000;
const MAX_CONCURRENT_GENERATIONS = 2;

// Ephoto effect names verified against the live endpoint (a probe with each of
// these reached the generator instead of answering "Invalid effect name.").
// The API owns the real list: an effect that is not on it is refused cleanly by
// the API and reported back, so no invented list is ever hardcoded as truth.
const VERIFIED_EPHOTO_EFFECTS = Object.freeze([
  'glitchtext', 'writetext', 'luxurygold', 'galaxywallpaper', 'blackpinklogo', 'makingneon'
]);

// ── provider registry + adapters ───────────────────────────────────────────
// Fallback order inside TEXT_TO_IMAGE: every one of these answered a live probe
// with a usable image, and they are different upstream models, so the chain
// survives a single upstream outage. Flixier is last because it answers with a
// signed S3 object plus a thumbnail rather than a plain URL.

const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'fluxv2',
    name: 'Flux V2',
    operation: OPERATIONS.TEXT_TO_IMAGE,
    endpoint: dc.IMAGE_ENDPOINTS.fluxv2,
    keywords: Object.freeze(['flux', 'fluxv2']),
    call: (input) => dc.fluxV2Image(input.prompt)
  }),
  Object.freeze({
    id: 'animagine',
    name: 'Aanimagine',
    operation: OPERATIONS.TEXT_TO_IMAGE,
    endpoint: dc.IMAGE_ENDPOINTS.animagine,
    keywords: Object.freeze(['animagine', 'aanimagine']),
    call: (input) => dc.animagineImage(input.prompt)
  }),
  Object.freeze({
    id: 'writecream',
    name: 'WriteCream Image',
    operation: OPERATIONS.TEXT_TO_IMAGE,
    endpoint: dc.IMAGE_ENDPOINTS.writecream,
    keywords: Object.freeze(['writecream']),
    call: (input) => dc.writecreamImage(input.prompt)
  }),
  Object.freeze({
    id: 'epicrealism',
    name: 'EpicRealism',
    operation: OPERATIONS.TEXT_TO_IMAGE,
    endpoint: dc.IMAGE_ENDPOINTS.epicrealism,
    keywords: Object.freeze(['epicrealism', 'realism', 'realistic']),
    call: (input) => dc.epicrealismImage(input.prompt)
  }),
  Object.freeze({
    id: 'flixier',
    name: 'Flixier AI',
    operation: OPERATIONS.TEXT_TO_IMAGE,
    endpoint: dc.IMAGE_ENDPOINTS.flixier,
    keywords: Object.freeze(['flixier']),
    call: (input) => dc.flixierImage(input.prompt)
  }),
  Object.freeze({
    id: 'nanobanana2',
    name: 'Nanobanana 2',
    operation: OPERATIONS.IMAGE_TO_IMAGE,
    endpoint: dc.IMAGE_ENDPOINTS.nanobanana2,
    keywords: Object.freeze(['nanobanana', 'nanobanana2', 'banana']),
    call: (input) => dc.nanobanana2Edit(input.imageUrl, input.prompt)
  }),
  Object.freeze({
    id: 'pixwith',
    name: 'PixWith AI',
    operation: OPERATIONS.IMAGE_TO_IMAGE,
    endpoint: dc.IMAGE_ENDPOINTS.pixwith,
    keywords: Object.freeze(['pixwith']),
    call: (input) => dc.pixwithEdit(input.imageUrl, input.prompt)
  }),
  Object.freeze({
    id: 'ephoto',
    name: 'Ephoto Effects',
    operation: OPERATIONS.IMAGE_EFFECT,
    endpoint: dc.IMAGE_ENDPOINTS.ephoto,
    keywords: Object.freeze(['ephoto', 'ephoto360']),
    // Single-provider operation: an Ephoto effect cannot be produced by a
    // text→image model, so there is deliberately no cross-operation fallback.
    call: (input) => dc.ephotoEffect(input.effect, input.text)
  })
]);

const KEYWORD_LOOKUP = new Map();
for (const provider of PROVIDERS) {
  KEYWORD_LOOKUP.set(provider.id, provider);
  for (const keyword of provider.keywords) KEYWORD_LOOKUP.set(keyword, provider);
}

function providersFor(operation, preferredId) {
  const chain = PROVIDERS.filter((provider) => provider.operation === operation);
  const preferred = chain.find((provider) => provider.id === preferredId);
  if (!preferred) return chain;
  return [preferred, ...chain.filter((provider) => provider.id !== preferredId)];
}

// "!image flux cyberpunk city" pins a provider; "!image anime boy" does not,
// because "anime" is not a provider keyword.
function resolveProviderKeyword(token, operation) {
  const key = String(token || '').trim().toLowerCase();
  if (!key) return undefined;
  const provider = KEYWORD_LOOKUP.get(key);
  if (!provider) return undefined;
  if (operation && provider.operation !== operation) return undefined;
  return provider;
}

// ── normalized image result ────────────────────────────────────────────────
// Only fields the provider actually returned are present — nothing is forced.

function normalizeImageResult({ provider, operation, reference, meta = {}, input = {} }) {
  const result = {
    success: true,
    type: 'image',
    provider: provider.name,
    providerId: provider.id,
    operation,
    endpoint: provider.endpoint
  };
  if (reference.startsWith('data:')) {
    const comma = reference.indexOf(',');
    result.imageBase64 = reference.slice(comma + 1);
    result.mimeType = reference.slice('data:'.length, reference.indexOf(';')) || 'image/png';
  } else {
    result.imageUrl = reference;
  }
  // The user's own words win over a provider echo, so the caption always shows
  // what was actually asked for.
  const prompt = input.prompt || meta.prompt;
  if (prompt) result.prompt = String(prompt);
  if (input.effect) result.effect = String(input.effect);
  if (input.text && !result.prompt) result.text = String(input.text);

  const metadata = {};
  for (const key of ['ratio', 'style', 'status', 'resolution', 'thumb', 'expires', 'creator']) {
    if (meta[key] !== undefined) metadata[key] = meta[key];
  }
  if (Object.keys(metadata).length) result.metadata = metadata;
  return result;
}

// ── success validation (HTTP 200 alone is never enough) ────────────────────

const IMAGE_SIGNATURES = Object.freeze([
  { mimeType: 'image/png', extension: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mimeType: 'image/jpeg', extension: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: 'image/gif', extension: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { mimeType: 'image/webp', extension: 'webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.slice(8, 12).toString('latin1') === 'WEBP' },
  { mimeType: 'image/bmp', extension: 'bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d }
]);

function inspectImageBuffer(buffer, declaredType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) return null;
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.test(buffer)) return { mimeType: signature.mimeType, extension: signature.extension };
  }
  // Some CDNs serve AVIF/HEIF/TIFF: trust a declared image content type when the
  // payload is a plausible size, but never trust a non-image content type.
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff)$/.test(declared)) {
    return { mimeType: declared, extension: declared.slice('image/'.length).replace('jpeg', 'jpg') };
  }
  return null;
}

// Downloads (or decodes) the provider reference and proves it is a real image.
// Provider URLs go through the project's existing public-HTTPS guard, so an
// API-returned URL can never be turned into an internal/SSRF request.
async function materializeImage(normalized) {
  if (normalized.imageBase64 !== undefined) {
    const buffer = Buffer.from(normalized.imageBase64, 'base64');
    const inspected = inspectImageBuffer(buffer, normalized.mimeType);
    if (!inspected) throw new Error('decoded payload is not a readable image');
    return { buffer, filename: `animemd-${normalized.providerId}.${inspected.extension}`, ...inspected };
  }
  const url = publicHttpsUrl(normalized.imageUrl).href;
  const { buffer, type } = await downloadRemoteFile(url, MAX_IMAGE_BYTES);
  const inspected = inspectImageBuffer(buffer, type);
  if (!inspected) throw new Error('downloaded payload is not a readable image');
  return { buffer, filename: `animemd-${normalized.providerId}.${inspected.extension}`, ...inspected };
}

// ── rate limit / resource protection ───────────────────────────────────────
// Same shape as system/lib/ai.js reserveAiRequest(): one bounded per-sender
// cooldown plus one small global in-flight cap. No second rate-limit framework.

const recentImageRequests = new Map();
let generationsInFlight = 0;

function reserveImageRequest(sender, cooldownMs = REQUEST_COOLDOWN_MS) {
  const key = String(sender || 'anonymous');
  const now = Date.now();
  const previous = recentImageRequests.get(key) || 0;
  const remaining = cooldownMs - (now - previous);
  if (remaining > 0) return { ok: false, waitSeconds: Math.ceil(remaining / 1000) };
  recentImageRequests.set(key, now);
  const timer = setTimeout(() => {
    if (recentImageRequests.get(key) === now) recentImageRequests.delete(key);
  }, cooldownMs);
  timer.unref?.();
  return { ok: true };
}

function inFlightCount() {
  return generationsInFlight;
}

// Non-mutating peek so a command can refuse early (before any progress note,
// media download or upload) when the queue is busy or the sender is cooling down.
function imageGateStatus(sender, cooldownMs = REQUEST_COOLDOWN_MS) {
  if (generationsInFlight >= MAX_CONCURRENT_GENERATIONS) return { busy: true };
  const key = String(sender || 'anonymous');
  const remaining = cooldownMs - (Date.now() - (recentImageRequests.get(key) || 0));
  return remaining > 0 ? { cooldownSeconds: Math.ceil(remaining / 1000) } : {};
}

// ── image service ──────────────────────────────────────────────────────────

async function requestImage({ operation, input, preferred }) {
  const chain = providersFor(operation, preferred?.id);
  const attempts = [];
  for (const provider of chain) {
    try {
      const data = await provider.call(input);
      if (!dc.isValidResult(data)) throw new Error(dc.pickApiMessage(data) || 'provider reported no result');
      // An image-to-image provider must not be allowed to hand the source image
      // back as its own result.
      const reference = dc.pickImageUrl(data, { exclude: input.imageUrl ? [input.imageUrl] : [] });
      if (!reference) throw new Error(dc.pickApiMessage(data) || 'response contained no image reference');
      const normalized = normalizeImageResult({
        provider,
        operation,
        reference,
        meta: dc.pickImageMeta(data),
        input
      });
      const media = await materializeImage(normalized);
      return { ...normalized, ...media, attempts };
    } catch (error) {
      const reason = cleanText(String(error?.message || error || 'unknown reason'), 180);
      attempts.push({ provider: provider.name, reason });
      console.warn(`[image] ${provider.id} (${operation}): ${reason}`);
      // An unknown Ephoto effect can never succeed on another provider: the
      // effect list belongs to that single endpoint, so stop early and explain.
      if (provider.id === 'ephoto' && /invalid effect/i.test(reason)) {
        return { success: false, operation, invalidEffect: true, effect: input.effect, attempts };
      }
    }
  }
  return { success: false, operation, attempts };
}

// `onStart` runs only once the request has actually been accepted, so a
// cooldown/busy refusal never shows a "generating…" note first.
async function generateImage(operation, input, { preferred, sender, onStart } = {}) {
  if (generationsInFlight >= MAX_CONCURRENT_GENERATIONS) {
    return { success: false, operation, busy: true };
  }
  const gate = reserveImageRequest(sender);
  if (!gate.ok) return { success: false, operation, cooldownSeconds: gate.waitSeconds };
  generationsInFlight += 1;
  try {
    if (typeof onStart === 'function') await onStart();
    return await requestImage({ operation, input, preferred });
  } finally {
    generationsInFlight -= 1;
  }
}

// ── AnimeMD media sender + response design ─────────────────────────────────

function captionFor(result) {
  const heading = result.operation === OPERATIONS.IMAGE_EFFECT ? '*EPHOTO EFFECT READY* 🎨' : '*IMAGE READY* 🎨';
  const lines = [heading, ''];
  if (result.prompt) lines.push(`📝 *Prompt:* ${cleanText(result.prompt, 140)}`);
  if (result.effect) lines.push(`✨ *Effect:* ${cleanText(result.effect, 60)}`);
  if (result.text && !result.prompt) lines.push(`✍️ *Text:* ${cleanText(result.text, 140)}`);
  lines.push(`🤖 *Provider:* ${result.provider}`);
  lines.push(`🧩 *Operation:* ${OPERATION_LABEL[result.operation] || result.operation}`);
  if (result.metadata?.resolution) {
    lines.push(`📐 *Size:* ${result.metadata.resolution.width}×${result.metadata.resolution.height}`);
  }
  if (result.metadata?.ratio) lines.push(`📏 *Ratio:* ${cleanText(String(result.metadata.ratio), 20)}`);
  if (result.metadata?.style) lines.push(`🖌️ *Style:* ${cleanText(String(result.metadata.style), 40)}`);
  lines.push('', `> ${FOOTER}`);
  return lines.join('\n');
}

async function sendGeneratedImage(socket, context, result) {
  await socket.sendMessage(context.chatId, {
    image: result.buffer,
    mimetype: result.mimeType,
    caption: captionFor(result)
  }, { quoted: context.raw });
}

// ── command router ─────────────────────────────────────────────────────────
// Three commands cover the three operations. Provider-specific commands are not
// created: the eight providers are selectable through one unified command
// (`!image flux …`) and otherwise fall back automatically.

// Usage lines are built by the caller with the bot's live prefix, so they keep
// working after !setprefix.
function usageText(title, lines) {
  return [`*${title}*`, '', ...lines, '', `> ${FOOTER}`].join('\n');
}

function refusalText(result, operation, prefix) {
  if (result.cooldownSeconds) {
    return `*IMAGE GENERATION* ⏳\nPlease wait ${result.cooldownSeconds} seconds before another image request.`;
  }
  if (result.busy) {
    return '*IMAGE GENERATION* ⏳\nThe image queue is busy right now. Please send your request again in a moment.';
  }
  if (result.invalidEffect) {
    return [
      '*EPHOTO EFFECT* ❓',
      `"${cleanText(String(result.effect || ''), 40)}" is not an effect this API knows.`,
      '',
      `*Verified examples:* ${VERIFIED_EPHOTO_EFFECTS.join(', ')}`,
      `*Usage:* ${prefix}ephoto <effect> <text>`
    ].join('\n');
  }
  const chain = providersFor(operation).map((provider) => provider.name).join(', ');
  return [
    `*${operation === OPERATIONS.IMAGE_EFFECT ? 'EPHOTO EFFECT' : 'IMAGE GENERATION'}* ❌`,
    'No usable image came back for that request, so nothing was sent.',
    `Providers tried in order: ${chain}.`,
    'Please try again in a moment — image models are occasionally busy.'
  ].join('\n');
}

async function handleImageCommand(socket, context, command, deps = {}) {
  const prefix = deps.prefix || '!';
  const reply = (text) => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  try {
    const tokens = String(command?.text || '').trim().split(/\s+/).filter(Boolean);
    const pinned = resolveProviderKeyword(tokens[0], OPERATIONS.TEXT_TO_IMAGE);
    const promptTokens = pinned && tokens.length > 1 ? tokens.slice(1) : tokens;
    const prompt = cleanText(promptTokens.join(' '), MAX_PROMPT_LENGTH);
    if (!prompt) {
      await reply(usageText('IMAGE GENERATION 🎨', [
        `*Usage:* ${prefix}image <prompt>`,
        `*Example:* ${prefix}image cyberpunk city at night`,
        `*Pick a model:* ${prefix}image flux futuristic samurai`,
        `*Models:* ${providersFor(OPERATIONS.TEXT_TO_IMAGE).map((provider) => provider.id).join(', ')}`
      ]));
      return;
    }
    const gate = imageGateStatus(context.sender);
    if (gate.busy || gate.cooldownSeconds) {
      await reply(refusalText(gate, OPERATIONS.TEXT_TO_IMAGE, prefix));
      return;
    }
    const result = await generateImage(OPERATIONS.TEXT_TO_IMAGE, { prompt }, {
      preferred: pinned,
      sender: context.sender,
      onStart: () => reply(`🎨 *Generating image…*\n📝 ${cleanText(prompt, 120)}\n\n> ${FOOTER}`)
    });
    if (result.success) {
      await sendGeneratedImage(socket, context, result);
      return;
    }
    await reply(refusalText(result, OPERATIONS.TEXT_TO_IMAGE, prefix));
  } catch (error) {
    // An image provider must never be able to take the bot down with it.
    console.warn('[image] command guard:', cleanText(String(error?.message || error), 180));
    await reply(`*IMAGE GENERATION* ❌\nThat request could not be completed. Please try again.\n\n> ${FOOTER}`).catch(() => {});
  }
}

async function handleEphotoCommand(socket, context, command, deps = {}) {
  const prefix = deps.prefix || '!';
  const reply = (text) => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  try {
    const tokens = String(command?.text || '').trim().split(/\s+/).filter(Boolean);
    const effect = String(tokens[0] || '').trim().toLowerCase();
    const text = cleanText(tokens.slice(1).join(' '), MAX_EFFECT_TEXT_LENGTH);
    if (!effect) {
      await reply(usageText('EPHOTO TEXT EFFECT ✨', [
        `*Usage:* ${prefix}ephoto <effect> <text>`,
        `*Example:* ${prefix}ephoto glitchtext ANIME MD`,
        `*Verified effects:* ${VERIFIED_EPHOTO_EFFECTS.join(', ')}`,
        'Other effect names are checked by the API itself and refused cleanly.'
      ]));
      return;
    }
    // The effect is a path segment: refuse anything that is not a plain slug so
    // a malformed path can never be sent to the API.
    if (!dc.EFFECT_NAME_PATTERN.test(effect)) {
      await reply(`*EPHOTO EFFECT* ❓\n"${cleanText(effect, 40)}" is not a valid effect name.\nUse letters, numbers, "-" or "_" only.\n\n*Verified examples:* ${VERIFIED_EPHOTO_EFFECTS.join(', ')}`);
      return;
    }
    if (!text) {
      await reply(`*EPHOTO EFFECT* ✍️\nAdd the text to render.\n\n*Usage:* ${prefix}ephoto ${effect} <text>\n*Example:* ${prefix}ephoto ${effect} ANIME MD`);
      return;
    }
    const gate = imageGateStatus(context.sender);
    if (gate.busy || gate.cooldownSeconds) {
      await reply(refusalText(gate, OPERATIONS.IMAGE_EFFECT, prefix));
      return;
    }
    const result = await generateImage(OPERATIONS.IMAGE_EFFECT, { effect, text }, {
      sender: context.sender,
      onStart: () => reply(`✨ *Rendering Ephoto effect…*\n🖌️ ${effect}\n✍️ ${cleanText(text, 80)}\n\n> ${FOOTER}`)
    });
    if (result.success) {
      await sendGeneratedImage(socket, context, result);
      return;
    }
    await reply(refusalText(result, OPERATIONS.IMAGE_EFFECT, prefix));
  } catch (error) {
    console.warn('[image] ephoto guard:', cleanText(String(error?.message || error), 180));
    await reply(`*EPHOTO EFFECT* ❌\nThat effect could not be rendered. Please try again.\n\n> ${FOOTER}`).catch(() => {});
  }
}

async function handleImageEditCommand(socket, context, command, deps = {}) {
  const prefix = deps.prefix || '!';
  const reply = (text) => socket.sendMessage(context.chatId, { text }, { quoted: context.raw });
  try {
    const rawText = String(command?.text || '').trim();
    const inlineUrl = dc.extractUrl(rawText);
    const prompt = cleanText(inlineUrl ? rawText.replace(inlineUrl, ' ') : rawText, MAX_PROMPT_LENGTH);
    if (!prompt) {
      await reply(usageText('AI IMAGE EDIT 🖼️', [
        `*Usage:* reply to an image, then ${prefix}imgedit <prompt>`,
        `*Example:* ${prefix}imgedit turn this into anime style`,
        `*Or send a public image URL:* ${prefix}imgedit https://example.com/photo.jpg make it neon`,
        `*Models:* ${providersFor(OPERATIONS.IMAGE_TO_IMAGE).map((provider) => provider.id).join(', ')}`
      ]));
      return;
    }

    const gate = imageGateStatus(context.sender);
    if (gate.busy || gate.cooldownSeconds) {
      await reply(refusalText(gate, OPERATIONS.IMAGE_TO_IMAGE, prefix));
      return;
    }
    const progressNote = `🖼️ *Editing image…*\n📝 ${cleanText(prompt, 120)}\n\n> ${FOOTER}`;
    let imageUrl = '';
    if (inlineUrl) {
      try {
        imageUrl = publicHttpsUrl(inlineUrl).href;
      } catch {
        await reply('*AI IMAGE EDIT* ❓\nThat link is not a usable public HTTPS image URL.');
        return;
      }
      await reply(progressNote);
    } else {
      const media = getImageMessage(context.raw) || getStickerMessage(context.raw);
      if (!media) {
        await reply(`*AI IMAGE EDIT* 🖼️\nReply to an image or sticker first, then send ${prefix}imgedit <prompt>.`);
        return;
      }
      if (typeof deps.download !== 'function') {
        await reply('*AI IMAGE EDIT* ❌\nThe media downloader is not wired up on this bot right now.');
        return;
      }
      const mediaType = String(media.mimetype || '').includes('image') ? 'image' : 'sticker';
      const buffer = await deps.download(media, mediaType);
      if (!buffer?.length) {
        await reply('*AI IMAGE EDIT* ❌\nThat image could not be read. Please reply to another one.');
        return;
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        await reply(`*AI IMAGE EDIT* ❌\nThat image is larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`);
        return;
      }
      await reply(progressNote);
      const extension = String(media.mimetype || 'image/jpeg').split('/')[1] || 'jpg';
      // The edit APIs need a public URL, so the existing !tourl uploader is reused.
      imageUrl = await uploadToCatbox(deps.uploadApiUrl, buffer, {
        filename: `animemd-edit.${extension}`,
        mimetype: media.mimetype || 'image/jpeg'
      });
    }

    const result = await generateImage(OPERATIONS.IMAGE_TO_IMAGE, { imageUrl, prompt }, { sender: context.sender });
    if (result.success) {
      await sendGeneratedImage(socket, context, result);
      return;
    }
    await reply(refusalText(result, OPERATIONS.IMAGE_TO_IMAGE, prefix));
  } catch (error) {
    console.warn('[image] edit guard:', cleanText(String(error?.message || error), 180));
    await reply(`*AI IMAGE EDIT* ❌\nThat edit could not be completed. Please try again.\n\n> ${FOOTER}`).catch(() => {});
  }
}

module.exports = {
  // Registry / architecture
  OPERATIONS,
  OPERATION_LABEL,
  PROVIDERS,
  VERIFIED_EPHOTO_EFFECTS,
  providersFor,
  resolveProviderKeyword,
  // Limits
  MAX_PROMPT_LENGTH,
  MAX_EFFECT_TEXT_LENGTH,
  MAX_IMAGE_BYTES,
  REQUEST_COOLDOWN_MS,
  MAX_CONCURRENT_GENERATIONS,
  // Adapters / normalization / validation
  normalizeImageResult,
  inspectImageBuffer,
  materializeImage,
  // Service
  requestImage,
  generateImage,
  reserveImageRequest,
  imageGateStatus,
  inFlightCount,
  // Command router
  captionFor,
  handleImageCommand,
  handleEphotoCommand,
  handleImageEditCommand
};
