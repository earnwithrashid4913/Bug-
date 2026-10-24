'use strict';
// Host-side provider check. Does not start the bot, change auth, or upload to
// WhatsApp. No credentials or signed media URLs are printed.
const fs = require('node:fs/promises');
const { createProviderChain, createLocalProvider, youtubeUrl } = require('../system/lib/youtube-engine');
async function main() {
  const [input, kind = 'info', resolution] = process.argv.slice(2);
  if (!input || !['info', 'audio', 'voice', 'video'].includes(kind) || (resolution && !/^\d{2,4}$/.test(resolution))) {
    console.error('Usage: node scripts/youtube-check.js <YouTube URL> [info|audio|voice|video] [video-height]');
    process.exitCode = 1; return;
  }
  const provider = createProviderChain([createLocalProvider()]);
  let media;
  try {
    const info = await provider.inspect(youtubeUrl(input));
    console.log(JSON.stringify({ metadata: true, title: info.title, duration: info.duration, audio: info.audio, qualities: info.qualities.map(q => q.height) }));
    if (kind !== 'info') {
      const height = resolution ? Number(resolution) : info.qualities[0]?.height;
      media = await provider.download(info, kind, height, async stage => console.log(stage));
      console.log(JSON.stringify({ downloadedAndValidated: true, kind, bytes: (await fs.stat(media.file)).size, mimetype: media.mimetype, whatsappDeliveryTested: false }));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'CHECK_FAILED', message: error.code ? error.message : 'Provider check failed. Check the engine and network configuration.' }));
    process.exitCode = 1;
  } finally { if (media) await media.cleanup(); }
}
main().catch(() => { console.error('Provider check could not finish.'); process.exitCode = 1; });
