# ANIME MD — play/video pipeline repair and verification

Date: 2026-10-24. Active branch: `arena/c2d2848f-bug`.
Starting HEAD: `cd88ba873dc5748a7b41a00ab164b51b048dfb02`.

## Status first

**Implemented and tested in the existing bot; live production acceptance remains open.**
No successful live YouTube download or real WhatsApp delivery was observed. This sandbox
cannot reach the required providers and has no authenticated WhatsApp session directory.
The full test suite and synthetic media tests must not be presented as production success.

The checkout was clean at the start. It already contained merged PRs #63/#64 and the
subsequent UI work; those fixes were preserved. No ZIP was present in the workspace, so
this audit covers the supplied Git checkout, not an unseen archive. No branch switch,
authentication change, dispatcher replacement, provider replacement, commit or push was
needed for these edits.

## Scan and execution trace

Reviewed repository structure, package/lockfile, config normalization, startup/session
integration, command registry, source handlers, message decoder, shared native UI,
network helpers, recovered provider chain, local provisioning/extraction, strict quality
adapter, and related tests/reports. GitHub PR history confirmed the recovery and later
video-routing fixes. Installed Baileys remains **7.0.0-rc14**, CommonJS remains unchanged.

The live command path is:

1. `system/handler.js` receives/decodes the WhatsApp message, applies access/dedup gates,
   and routes registered play/video aliases to `commands/source-commands.js`.
2. `youtube-flow` validates a supported YouTube URL or searches once with the existing
   page helper/local search fallback. The canonical source is bound to the request.
3. The recovered adapter uses real search metadata; a direct URL now attempts bounded
   watch-page metadata without requiring local yt-dlp/FFmpeg first.
4. `!play` opens the native image-header HD VIDEO / AUDIO MP3 / VOICE TYPE card;
   `!video` opens the real-resolution list, retaining its thumbnail. Automatic video
   remains explicitly labeled when optional format discovery fails.
5. The existing decoder delivers quick/list IDs to the socket-local session. Sender,
   chat, expiry, revision and active-job checks precede downloads. Compatible quoted
   numeric replies and the existing unique-pending-number fallback remain supported.
6. Download the SAME selected URL through the preserved provider chain; explicit heights
   use the existing strict format selector/merge path and never silently downgrade.
7. Stream media into a private file (or hand off the local extractor's file), validate,
   convert if required, and pass a file URL plus honest MIME/name/PTT flags to Baileys.
8. Clean files once sendMessage has consumed them. Only a matching delivery receipt
   permits Completed/✅. Uncertain uploads are not blindly retried or sent via another
   provider. Native relay acknowledgments do not prove handset rendering.

## Confirmed root causes and repairs

| Finding | Repair |
|---|---|
| API downloads buffered whole media before writing a tempfile | Extended the existing `downloadRemoteFile` with an optional exclusive file sink; streaming/backpressure, byte counting, idle/upstream cancellation and partial cleanup. Existing buffer callers remain compatible. |
| Local fallback read its complete output into RAM, then the recovered adapter wrote it again | Optional `fileBacked` handoff transfers file ownership/cleanup; default legacy API remains unchanged for unrelated commands. |
| Legacy subprocess only checked output size after exit | Aggregate intermediate-disk watchdog now kills oversized running local jobs; every exit clears the watchdog and failed jobs clean their directory. |
| Streaming cancellation could stop at the HTTP body, not a stalled disk sink | The stream pipeline itself receives the abort signal; tested with a deliberately stalled writable. |
| Shared fetch helper removed upstream cancellation as soon as headers arrived | Native composed signals retain cancellation through body consumption. |
| Watch metadata could be absent for direct links despite a known source | Added a best-effort parser on the existing canonical YouTube watch host, bounded to 4 seconds / 2 MiB, validating the exact video ID. No new download service or binary install. Failure keeps honest unknown labels and leaves API fallback available. |
| Native list relay explicitly disabled its image | Lists now prepare the provided thumbnail; image-free native fallback is attempted only on failure. Actual Baileys image preparation/protobuf is tested. |
| Compatibility cards exposed request IDs and printed internal retry action labels | User text now uses readable options and quoted replies; generated IDs remain inside callback payloads. Legacy ID parsing is retained for compatibility. |
| Bot-check/aggregate chat errors again prescribed cookies without evidence | Replaced with concise neutral errors. Detailed provider codes remain redacted server diagnostics; the legacy relaxed-format warning no longer prints token-bearing stderr. |
| EBML Matroska could be labeled WebM; H.264 alone did not establish pixel compatibility | Recognize Matroska signatures honestly. Recovered inline MP4 requires decoded H.264/yuv420p + AAC; incompatible media stays a document. The strict quality validator also rejects non-yuv420p output. |
| Declared-oversized metadata could leave its body open until timeout | Early size rejection now cancels the response body immediately. |

No endpoint was guessed, and no attempt was made to fix DNS/TLS by disabling certificate
verification, hardcoding IPs, bypassing access controls or changing auth/cookies.

## Preserved behavior and safeguards

- Audio provider order: DavidCyril MP3 pools → configured/historical Cobalt → pre-61 local.
- Automatic video: Cobalt → DavidCyril MP4 → DavidCyril AIO → pre-61 local.
- Original audio/direct/video aliases remain registered; video intent stays video-only.
- Real available resolutions, optional automatic mode, and no fabricated HD claims.
- Existing request expiry, per-process concurrency and provider family deadlines.
- Unique private tempdirs; file mode 0600 for streamed downloads; no overwrite/deletion
  of a pre-existing file when exclusive creation fails.
- Chunked signature/marker inspection uses 64 KiB reads, then FFmpeg full decode when
  installed. No full-media Buffer on the default play/video API or local fallback path.
  Metadata/thumbnails remain small bounded buffers; Baileys has its own upload overhead.
- File size is checked during streaming, before processing and before upload; converted
  output is capped. Local temporary intermediate storage is bounded to 3× the file limit.
- Valid mono 48 kHz Opus voice output, actual MP3 conversion, MIME/extensions and clean
  server-only failures. FFmpeg is required for voice; no fake voice output when absent.
- No song/URL substitution; another search result requires explicit user consent.
- Real-stage editable progress/reactions, no fake percentages or repeating timers.

## Tests and tools

The new `test/youtube-file-pipeline.test.js` covers real filesystem streaming, file mode,
empty/truncated/oversized/aborted bodies, exclusive-creation safety, stalled disk sink,
body-phase cancellation, cross-chunk markers, corrupt media, fallback cleanup,
source-matched/escaped/malformed/missing/oversized metadata, best-effort failure and
actual FFmpeg MP3/Opus/MP4 conversion/decode with yuv420p vs yuv444p behavior.

Existing dispatcher tests now consume emitted native IDs rather than scraping visible
request tokens. Added native-list thumbnail/privacy tests and local file-handoff/storage
watchdog tests. Existing tests were retained; no test was removed or skipped to get green.

- Focused YouTube + local downloader: **176 passed, 0 failed, 0 skipped**.
- Final full `npm test`: **887 total — 886 passed, 0 failed, 1 skipped**. The
  existing skipped supervisor test requires a real WhatsApp connection; none of
  the focused media/streaming/native tests was skipped.
- Syntax: **114/114 JavaScript files** pass.
- Dry startup passes without opening WhatsApp.
- Dependency tree validates; audit finds **0 vulnerabilities**.
- Registry/menu audits pass: **144 public commands, 302 names/aliases, 23 categories**.
- Package manifest and lockfile are unchanged; no npm dependency added/removed/upgraded.
- Local-only tools reinstalled outside the repo: yt-dlp **2026.10.21** with matching EJS
  **0.8.0**, FFmpeg **7.0.2**. These external tools are not shipped with this patch.

Evidence boundaries: actual Node streams, tempfiles, subprocesses, FFmpeg generation/
full decoding, Baileys protobuf/preparation and the real dispatcher are exercised.
External HTTP/providers and upload/relay are mocked in deterministic tests. The generated
clips are synthetic; their success is not evidence of actual YouTube/WhatsApp playback.

## Fresh live verification — exact unresolved results

Performed real isolated audio attempts, automatic video, search-query attempts and the
host transport/self-test with the tools above. All provider attempts returned nonzero.

| Target | Fresh result |
|---|---|
| YouTube watch/search and local extractor | DNS resolves, TCP connects, TLS resets before handshake; yt-dlp reports TLS/SSL EOF fetching the API |
| DavidCyril audio / MP4 / AIO | ECONNRESET before secure TLS connection is established |
| Historical Cobalt host | DNS A and AAAA ENODATA; OS lookup/fetch ENOTFOUND for cobalt-api.kwiatekmiki.com |
| GitHub transport control | Default Node reports UNABLE_TO_VERIFY_LEAF_SIGNATURE in this environment |
| Host FFmpeg self-test | Synthetic H.264/AAC MP4, MP3 and Opus conversion/full decode succeeds |
| WhatsApp | No auth directory/test socket available; no delivery or handset test performed |

This sandbox only allows selected package/GitHub hosts. These observations do not establish
production provider uptime or the production root cause. BOT_CHECK was not reproduced or
resolved live; it remains a separately tested classification, not a reason to prescribe
cookies. The current provider endpoints were preserved rather than replacing them with an
unverified alternative. Actual metadata parsing on YouTube remains live-unverified too.

## Remaining limitations

- Successful real downloads, provider uptime, production BOT_CHECK diagnosis, native
  handset rendering and actual WhatsApp receipt/playback are not verified here.
- Watch-page metadata depends on YouTube's current HTML structure. If it changes or
  fails, the initial card honestly falls back to unknown values; no provider is disabled.
- Without FFmpeg, marker checks are only heuristics, not complete integrity/codec proof.
  Install FFmpeg for validated deployment; unsupported original codecs may be documents.
- Limits are per provider/subprocess/phase, not one single whole-job deadline. Existing
  selection sessions are in memory, expire, and do not survive process restarts.
- Trust only owner-configured providers. Media URL protocol/credential checks and strict
  user YouTube validation do not replace DNS-pinned egress/firewall policy for untrusted
  provider-controlled CDN URLs. Baileys may allocate its own upload buffers.

## Host acceptance and deployment

1. Preserve auth/data and review the diff. Install native FFmpeg and a maintained yt-dlp
   with its matching JS solver as documented in DEPLOYMENT.md. Set absolute tool paths
   where needed; Termux must use native packages and disable incompatible auto-installs.
2. Run `npm ci`, `npm run lint`, `npm test`, `npm run smoke` on the actual bot host.
3. Run `node scripts/youtube-host-check.js --media-self-test`. This verifies transport/
   synthetic conversion only, not provider availability or delivery.
4. Use a short public video you control, explicitly supplying its URL; run
   `node scripts/youtube-check.js '<URL>' audio --provider=davidcyril`, then the same
   with `cobalt` and `local`. Also test `video`, `voice`, both spaced searches and
   `formats`; request only a height actually returned. `info` is not a download test.
5. Restart the existing supervisor once, without deleting sessions. On a connected
   recipient device, test `!play`/`!video`, native actions and quality list, MP3/Opus/video
   playback, selected resolution, quoted fallback, duplicate/stale/unauthorized taps,
   two users, interrupted upload and receipt-only completion. No real-host/device
   success has been supplied for this branch, so these acceptance gates remain open.

## Exact changed files

- `system/lib/net-tools.js`: compatible file streaming, cancellation, bounded watch metadata.
- `system/lib/local-downloader.js`: file ownership handoff and running storage watchdog.
- `system/lib/youtube-recovered.js`: file-based validation/preparation, MIME/codec checks,
  metadata enrichment while preserving all provider paths.
- `system/lib/youtube-engine.js`: strict inline-video pixel format validation.
- `system/lib/youtube-flow.js`: safe neutral chat errors.
- `system/lib/youtube-ui.js`: native list thumbnail and clean compatibility text.
- `scripts/youtube-check.js`: reports the actual metadata source.
- `test/youtube-file-pipeline.test.js` (new), `test/local-downloader.test.js`,
  `test/youtube-dispatch.test.js`, `test/youtube-native.test.js`: targeted regressions.
- `DEPLOYMENT.md`: updated file-backed behavior and deployment guidance.
- `YOUTUBE-DOWNLOAD-REPAIR.md`, `YOUTUBE-ROLLBACK-REPORT.md`,
  `YOUTUBE-INTERACTIVE-REPAIR.md`: point historical reports to this current follow-up.
- `PLAY-VIDEO-REBUILD-REPORT.md`: this report.

Changes remain on `arena/c2d2848f-bug`. To safely snapshot additional uncommitted work,
review `git status --short`, then `git stash push -u -m 'play-video repair backup'`;
restore with `git stash apply 'stash@{0}'` on this same branch. Do not reset main,
force-push, delete the session/data directory, or switch to an older session branch.
