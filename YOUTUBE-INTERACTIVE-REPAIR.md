# Scoped download repair + native selections

> Current branch follow-up: [PLAY-VIDEO-REBUILD-REPORT.md](PLAY-VIDEO-REBUILD-REPORT.md). Earlier test counts and buffering descriptions below are historical.

Date: 2026-10-24. Branch: `arena/25f7c45e-bug`.

## Latest PR follow-up verification

Existing fixes were preserved. Added `scripts/youtube-host-check.js` and its tests:
a no-auth, no-install, TLS-verifying transport/tool diagnostic, with an optional
synthetic FFmpeg H.264/AAC → MP3/Opus full-decode self-test. Root HTTP responses
are explicitly **not** treated as download-provider availability.

Fresh sandbox checks separate working DNS plus pre-handshake TLS resets for
YouTube/DavidCyril from missing A/AAAA records for the historical Cobalt host.
The GitHub control also exposed a Node trust-store mismatch: default Node failed
with UNABLE_TO_VERIFY_LEAF_SIGNATURE; curl and Node with the operator-provided
system CA bundle verified successfully (HTTP 200). That control does not fix or
explain away the YouTube/DavidCyril resets. No insecure TLS option was introduced.

Confirmed code fixes: legacy bot-check errors no longer assert a personal-login/
cookies requirement; a challenge mentioning extraction no longer triggers a
pointless format retry. Fresh-host provisioning test fixtures now isolate PATH
from developer-installed Python yt-dlp; production engine discovery is unchanged.

Latest full regression, completed after the interrupted response: **847 total,
845 passed, 1 failed, 1 skipped**. The reconnect soak timed out after 7/12 cycles;
its isolated rerun passed all 12 cycles (1 test passed). This is **not** a fully
green full-suite result. Focused download/local tests passed 142/142; local
provisioning tests also passed with Python yt-dlp on PATH. Syntax 111/111, smoke,
registry/menu checks, dependency audit (0 vulnerabilities), and diff checks passed.
The earlier 838-test green run below predates these diagnostic/follow-up changes.

The user confirmed host/device access, but has not supplied deployment probe or
handset outcomes. Real production extraction, BOT_CHECK resolution, native-card
rendering, delivery receipt and playback remain **unverified**, not successful.

## Acceptance status — read first

**Implemented and locally tested; production download/handset acceptance is not passed.**
Fresh real requests in this sandbox still fail before media is received. No authenticated
WhatsApp handset was available. Tests using Baileys' actual message preparation/protobuf
and dispatcher do not establish handset rendering or WhatsApp delivery. Neither reaction
animation nor enabling a supported JS runtime is evidence that BOT_CHECK is solved.

This is a follow-up to the historical engine recovery in PR #62, not a new downloader
or bot rewrite. Original provider families/order and flexible automatic selectors remain:

- Audio: DavidCyril MP3 helpers → configured/historical Cobalt endpoints → pre-61 local.
- Automatic video: Cobalt → DavidCyril MP4 → DavidCyril AIO → pre-61 local.
- Only explicit real-resolution choices use the existing strict quality adapter.

No new endpoint, npm dependency, Baileys upgrade, lockfile change, authentication change,
QR login, dispatcher replacement, or silent alternate song was introduced.

## Inspection and Git recovery record

Starting HEAD: `dec2ec7cea41eaf8a9e861be213e137605d554b4` (merged PR #62).
The checkout was clean before this task. Work was developed on this same branch and is being submitted as a PR;
no reset, branch switch, force push, or session deletion was performed.

Inspected the active command registry/dispatcher, message decoder, installed Baileys
**7.0.0-rc14** APIs, shared UI, source commands, provider helpers, local provisioning,
configuration, tests, and Git history/latest merged PR before editing. Historical anchors:
`be909d2` (pre-61 engine), `8d3bb2f` (original provider calls), `c075960` (API removal),
`e60a70e` (strict-only PR #61), and recovery commit `61049c2` in PR #62. Git establishes
old behavior, not which remote providers function today. The old archive/Hector endpoint
was not present; no unseen endpoint was invented.

To save and temporarily back out the current uncommitted changes safely, review status
then stash tracked **and new** files (also saves any other current uncommitted work):

```sh
git status --short
git branch --show-current
# Expected branch: arena/25f7c45e-bug
git stash push -u -m 'backup scoped download and native UI repair'
# Restore that saved work later, on this same branch:
git stash apply 'stash@{0}'
```

Do not reset main, force push, or remove the auth/data directories. A read-only historical
comparison is `git show be909d2:system/lib/local-downloader.js`.

## Targeted findings and fixes

1. **UI:** the recovered media menu still used numbered text despite the installed bot's
   native-flow support. It now prepares an actual image header and HD VIDEO / AUDIO MP3 /
   VOICE TYPE quick replies. Real native lists handle quality/source/compatibility choices;
   text numbering is the final fallback, not the default. Failed thumbnail preparation can
   retain native controls with a concise thumbnail notice.
2. **Interaction state:** native IDs include token and menu revision. They bind to the
   socket-local request, chat, sender and five-minute expiry. Old HD taps cannot select a
   quality from a later list. Invalid/unauthorized/expired callbacks, parallel users and
   duplicate taps are tested. Direct ytmp3/ytmp4 automatic-download semantics remain;
   the direct-command/card callback race cannot start a second job.
3. **Real progress:** one editable status plus reactions on the original command advances
   through 🔍 Searching → 🎵 Resolving → ⬇️ Downloading → ⚙️ Preparing → 📤 Uploading →
   ✅ receipt-confirmed completion or ❌ failure. Preparation includes actual conversion/
   validation; stages not performed are not fabricated. Repeated provider stages are
   deduplicated. No interval, fake percentage, or perpetual spinner was added.
4. **Errors:** chat receives short safe text and appropriate native Retry/source choices,
   not BOT_CHECK/NETWORK/provider aggregates, signed URLs or raw exceptions. Recovery
   keeps the selected format; changing search result requires explicit consent. Server
   logs retain provider/classification and redacted error/cause codes. Upload uncertainty
   never offers a blind resend or enters another provider.
5. **Bounds:** optional cancellation flows through the original DavidCyril fetch/pools,
   Cobalt retry/backoff/JSON body and remote media body. A provider deadline stops the
   remaining endpoint pool; permanent Cobalt 4xx/refusal/malformed responses do not retry.
   `downloads.providerTimeoutMs` defaults to 45000 (1000–180000). This bounds each API
   attempt, not the whole multi-provider job. Each Cobalt endpoint and the MP4/AIO pools
   are separate attempts; the local subprocess, conversion, upload and receipt have their
   existing separate bounds. `downloads.maxConcurrent` defaults to 2 (1–8), shared across
   sockets in one bot process, not multiple worker processes.
6. **Runtime:** the recovered local helper capability-probes `--help` once per executable/
   version and enables the installed Node only if `--js-runtimes` is supported. Old binaries
   keep their compatible arguments; explicit runtime/false opt-out in the helper API is
   honored. Historical formats, host configuration and provisioning are retained. Search
   fallback now retains canonical URL, uploader and duration instead of a bare video ID.
7. **Media:** the existing MP3 response parser now prefers audio over a competing video
   URL. AAC/Ogg/MP4 output has honest MIME/extensions. Available FFmpeg fully decodes the
   recovered output, checks inline video H.264/AAC and voice Opus, and distinguishes
   conversion/invalid-media failures. Incompatible original video is sent as a document,
   not silently transcoded or mislabeled as inline-compatible MP4. Without FFmpeg,
   signature/stream/codec-marker checks are only heuristics, not complete validation.
   Voice explicitly requires the converter. Successful ordinary API downloads still do
   not require yt-dlp metadata or FFmpeg; original non-MP3 audio remains honestly labeled.
8. **Lifecycle:** prepared files are cleaned after successful upload, receipt timeout,
   upload exception, failed decoding and conversion. Work remains size/time bounded.
   API media is **bounded-buffered before private tempfile creation**, not true disk
   streaming. Budget RAM for configured concurrency, final buffers and Baileys overhead.

## Native compatibility controls

In `config.js` under `downloads`:

```js
interactiveMode: 'auto', // native quick replies → list → final compatibility fallback
maxConcurrent: 2,
providerTimeoutMs: 45000,
```

Use `interactiveMode: 'list'` if a real device fails to display quick replies; use
`'text'` only as explicit last-resort compatibility. Relay/preparation exceptions can be
auto-detected; a handset that acknowledges but does not render a card cannot. Verify on
actual recipient devices. Callback IDs are generated controls, not commands users must type.

## Fresh live network findings

All of these were actually attempted on 2026-10-24 with the installed tools, not inferred
from earlier PR tests. They returned nonzero; no media/delivery success was reported.

| Probe | Actual result |
|---|---|
| `New FunkS Latest 10 minutes`, audio | Search/fallback extraction: NETWORK |
| `memories hasan`, audio | Search/fallback extraction: NETWORK |
| Direct `BaW_jenozKc`, audio, automatic chain | DavidCyril/Cobalt/local all NETWORK |
| Same direct URL, video, automatic chain | Cobalt/DC MP4/DC AIO/local all NETWORK |
| Isolated DavidCyril audio | ECONNRESET before TLS handshake |
| Isolated Cobalt audio | ENOTFOUND for historical cobalt-api.kwiatekmiki.com |
| Isolated pre-61 local audio | YouTube API TLS/SSL EOF |

This sandbox only permits selected GitHub/package hosts; required YouTube, provider,
media-CDN and WhatsApp connectivity is unavailable. DNS/TLS observations here do not
prove provider uptime or a deployment-wide fault. BOT_CHECK is separately classified and
mock-tested, but was **not reproduced or resolved live** in these fresh blocked probes.
There is no evidence to prescribe cookies as the root-cause fix. Do not disable TLS checks,
circumvent access controls, substitute songs, or keep retrying permanent refusals.

## Verification evidence

Node 22.22.3 / npm 10.9.8. Local tools: yt-dlp 2026.10.21, yt-dlp-ejs 0.8.0,
FFmpeg 7.0.2. Python/tools were installed outside the repository; they are not shipped npm
dependencies and must be installed on the real host. Use the commands in DEPLOYMENT.md.

- Focused `node --test test/youtube-*.test.js`: **110 passed, 0 failed, 0 skipped**.
- Focused plus local-downloader: **133 passed, 0 failed, 0 skipped**.
- Earlier pre-follow-up full `npm test`: **838 total; 837 passed, 0 failed, 1 skipped**. The skipped
  case is the existing intentionally skipped real-supervisor respawn integration test
  (requires a real WhatsApp connection), not a media/native UI test.
- `npm run lint`: **109/109 JavaScript files** pass syntax checks.
- `npm run smoke`: passed dry startup; no WhatsApp connection opened.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- Registry/menu audits: **144 public commands, 302 names/aliases, 23 categories**;
  no missing/duplicate/stale menu commands.
- `git diff --check`: passed. Package manifest/lockfile unchanged; no generated media
  or capability-probe artifacts remain in the checkout.

The native tests use the actual installed Baileys media preparation, protobuf encode/
decode, emitted IDs, message decoder and dispatcher; media upload/relay transport and
providers are stubbed. Real FFmpeg tests generate/decode local audio/video/voice clips,
including H.264/AAC inline and MPEG-4 MP4 document output. They are not YouTube downloads.
The command audit narrowly ignores expected thumbnail/native-fallback notices before
its generic error matcher; it does not suppress arbitrary errors.

Coverage groups (mock/local evidence; live media/handset acceptance remains open):

1. Spaced/quoted queries and both reported searches.
2. Canonical direct watch/music/Shorts URLs and URL/SSRF rejection.
3. Actual audio extraction/file payload/MIME.
4. Video extraction/file payload/MIME and actual codec checks.
5. Opus voice conversion/PTT payload.
6. Actual native button/list IDs through real dispatcher/decoder.
7. Genuine available quality choices; no silent downgrade.
8. Missing thumbnail/format discovery and automatic-video fallback.
9. BOT_CHECK/permanent-refusal classification without automatic permanent retry.
10. DNS/TLS/NETWORK and rate-limit classification.
11. Timeouts, API pool/body cancellation and local process watchdog.
12. Empty/HTML/JSON/truncated/oversized media rejection.
13. Missing FFmpeg and failed conversion classification.
14. Upload exception/uncertainty and no blind resend.
15. Expiry/restart/stale revision rejection.
16. Unauthorized chat/sender and malformed selections.
17. Duplicate taps/messages and direct-command automatic-start race.
18. Bounded concurrency and independent users.
19. Cleanup on success, timeout and failure; receipt-only completion.
20. Original aliases, source consent, menu registry and unrelated command audit.

## Real-host deployment and acceptance

1. Preserve auth/session/data; review the diff and keep this branch. Install tools as in
   DEPLOYMENT.md (`yt-dlp[default]` supplies its matching EJS; FFmpeg needs libopus,
   libmp3lame, libx264/AAC). Set absolute tool paths and persistent writable bin/storage.
   Termux needs native packages and `downloads.autoInstall: false`, not a glibc binary.
2. Run `npm ci`, `npm run lint`, `npm test`, `npm run smoke`. Dependencies/lockfile did not
   change; do not upgrade Baileys to troubleshoot this patch. Ensure outbound YouTube,
   provider, CDN and WhatsApp access. Keep TLS verification enabled.
3. On the deployment host, run these actual download probes (not just `info`):

```sh
node scripts/youtube-check.js 'New FunkS Latest 10 minutes' audio
node scripts/youtube-check.js 'memories hasan' audio
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' video
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' voice
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio --provider=davidcyril
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio --provider=cobalt
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio --provider=local
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' formats
# Use a height actually returned above, not an invented resolution:
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' video 720
```

`info` only prepares a request; `formats` only discovers qualities. Neither proves a
download. If this sample source is unavailable on the host, explicitly choose a public
video you control and record its URL; do not silently switch songs in the bot. The CLI
removes test media and reports `whatsappDeliveryTested:false` even after a good download.

4. Restart the existing supervisor once (`npm start` if no supervisor). Do not pair again
   or delete credentials. Test `!play` with spaces and a direct URL, `!video`, `!ytmp3`,
   `!ytmp4`, all three native format controls, native resolution list, duplicate/stale/
   unauthorized taps, simultaneous users, missing thumbnail and failed upload. Try the
   list override if required by real devices; only then use text compatibility.
5. On an authenticated recipient handset, verify thumbnail/metadata first, actual audible
   MP3, playable video at the selected real height, Opus voice-note appearance/playback,
   no duplicate sends, stopped terminal progress, and ✅ only after a matching receipt.
   Check redacted server diagnostics for each provider failure. Do not mark production
   acceptance passed until the media reaches the handset and plays.

## Exact changed-file list

Runtime/config:
`commands/davidcyril-api.js`, `config.js`, `system/config.js`,
`system/lib/local-downloader.js`, `system/lib/net-tools.js`, `system/lib/ui.js`,
`system/lib/youtube-flow.js`, `system/lib/youtube-recovered.js`,
new `system/lib/youtube-ui.js`. New diagnostic CLI: `scripts/youtube-host-check.js`.

Tests:
`test/local-downloader.test.js` (capability-help fixture, no generated --help file),
`test/whatsapp-command-audit.test.js`, `test/youtube-flow.test.js`,
`test/youtube-recovery.test.js`, new `test/youtube-native.test.js`,
new `test/youtube-provider-bounds.test.js`, and new `test/youtube-host-check.test.js`.

Documentation:
`DEPLOYMENT.md`, historical report links in `YOUTUBE-DOWNLOAD-REPAIR.md` and
`YOUTUBE-ROLLBACK-REPORT.md`, and this new `YOUTUBE-INTERACTIVE-REPAIR.md`.
