'use strict';
// Uses the SAME recovered provider/search path as the bot, but never connects to
// WhatsApp. Query resolution and provider success are reported separately.
const fs = require('node:fs/promises');
const net = require('../system/lib/net-tools');
const local = require('../system/lib/local-downloader');
const { youtubeUrl, classifyError, MediaError } = require('../system/lib/youtube-engine');
const { createRecoveredProvider } = require('../system/lib/youtube-recovered');
async function main() {
  const argv = process.argv.slice(2);
  const selected = argv.find(arg => arg.startsWith('--provider='))?.split('=')[1] || 'auto';
  const [input, kind = 'info', resolution] = argv.filter(arg => !arg.startsWith('--provider='));
  if (!input || !['info', 'formats', 'audio', 'voice', 'video'].includes(kind) ||
      !['auto', 'davidcyril', 'cobalt', 'local'].includes(selected) || (resolution && !/^\d{2,4}$/.test(resolution))) {
    console.error('Usage: node scripts/youtube-check.js "<YouTube URL or query>" [info|formats|audio|voice|video] [height] [--provider=auto|davidcyril|cobalt|local]');
    process.exitCode = 1; return;
  }
  const provider = createRecoveredProvider({}, { onlyProvider: selected === 'auto' ? undefined : selected });
  let media;
  try {
    let url, seed = {};
    if (/^[a-z][a-z\d+.-]*:/i.test(input)) url = youtubeUrl(input);
    else {
      let results;
      try { results = await net.youtubeSearch(input, 5); }
      catch { results = await local.searchVideo(input, undefined, 5); }
      if (!results?.[0]?.url) throw new MediaError('SEARCH', 'No YouTube results found.');
      seed = results[0]; url = youtubeUrl(seed.url);
    }
    const info = await provider.inspect(url, seed);
    console.log(JSON.stringify({ requestPrepared: true, metadataSource: info.metadataSource || (seed.title ? 'search' : 'fallback labels; extractor not called'), title: info.title, url: info.url, whatsappDeliveryTested: false }));
    if (kind === 'formats') {
      const qualities = await provider.qualities(info);
      console.log(JSON.stringify({ qualities: qualities.map(q => q.height), automaticVideoStillAvailable: true }));
    } else if (kind !== 'info') {
      media = await provider.download(info, kind, resolution ? Number(resolution) : undefined, async stage => console.log(stage));
      console.log(JSON.stringify({ downloaded: true, provider: media.provider || 'exact-quality-local', kind,
        bytes: (await fs.stat(media.file)).size, mimetype: media.mimetype, notice: media.notice, whatsappDeliveryTested: false }));
    }
  } catch (error) {
    const safe = error instanceof MediaError ? error : classifyError(error.message);
    console.error(JSON.stringify({ ok: false, code: safe.code, message: safe.message, whatsappDeliveryTested: false }));
    process.exitCode = 1;
  } finally { if (media) await media.cleanup(); }
}
main().catch(() => { console.error('Provider check could not finish.'); process.exitCode = 1; });
