# ANIME MD — YouTube download repair and verification

> Current branch follow-up: [PLAY-VIDEO-REBUILD-REPORT.md](PLAY-VIDEO-REBUILD-REPORT.md). Earlier test counts and buffering descriptions below are historical.

> Current native-UI/provider-bounds follow-up: [YOUTUBE-INTERACTIVE-REPAIR.md](YOUTUBE-INTERACTIVE-REPAIR.md).
> This document retains its historical implementation and test evidence.

> Historical PR #61 report. The user reported a production regression after this
> PR. Its yt-dlp-only defaults and mandatory metadata/converter prerequisites
> have been superseded by the targeted recovery in
> [YOUTUBE-ROLLBACK-REPORT.md](YOUTUBE-ROLLBACK-REPORT.md). The old test counts and
> architecture claims below describe that PR, not the current recovered defaults.

Audit date: 2026-10-24. Branch: `arena/fcb80884-bug`.

## Verification status — read this first

The repair is implemented in the existing CommonJS bot, with automated tests
through its real dispatcher. Local subprocesses, actual FFmpeg conversion,
file validation and cleanup were exercised. **Live YouTube extraction/download
and authenticated WhatsApp delivery could not be verified in this environment.**

A real yt-dlp probe against `BaW_jenozKc` failed fetching both the webpage and
YouTube API with `TLS/SSL connection has been closed (EOF)`. This sandbox permits
outbound traffic only to selected package/GitHub hosts, not YouTube/Google media
CDNs or WhatsApp. That result is not evidence that the video or provider is down.
No authentication/session changes were made to try to circumvent that restriction.

Therefore the final live end-to-end acceptance criterion remains **unverified**,
not passed. Run the host checks and WhatsApp acceptance procedure below.

## What was actually in the checkout

- `package.json` declares CommonJS and Node >=20.9. Tests ran on Node **22.22.3**,
  npm **10.9.8**; Node 22 is recommended for this installed Baileys integration.
- The installed integration is `@whiskeysockets/baileys@7.0.0-rc14`, not an
  Alannxd fork. It was not upgraded or replaced.
- The live command switch is `system/handler.js`. It delegates all YouTube
  aliases to `commands/source-commands.js`.
- The original named `ytmp3.js` and `ytmp4.js` files are **not present**.
  No Hector endpoint is present in the tracked implementation. Historical reports
  refer to source flows, but the archive used by `scripts/source-audit.js`
  (`abcd New Folder.zip`) is absent too. There was no factual endpoint to probe,
  preserve as an enabled provider, or safely reconstruct from those reports.
- `system/lib/local-downloader.js` already provides yt-dlp/FFmpeg resolution,
  automatic provisioning, metadata, searching and buffer-returning legacy APIs.
- The bot already decodes native-flow, list and button responses in
  `system/lib/message.js`. It also has native interactive UI helpers. None of
  those constitute proof that a new button renders on a real handset.
- No screenshot image was attached in this checkout/session. The implementation
  follows the functional thumbnail/title/uploader/duration/three-option reference,
  with ANIME MD branding, rather than claiming a pixel-matched screenshot.

## Root causes in the active implementation

1. There was no media selection session or callback state. Search/download
   aliases could only take the immediate-download path, not the requested menu.
2. Media metadata and thumbnails were not sent before the file. Audio received
   a short title message; video received its title only as the final caption.
3. Video used hardcoded <=720 selectors with relaxed fallback. The user could
   not choose a verified available resolution, and fallback could change it.
4. When FFmpeg was absent, audio could be M4A, Opus or WebM rather than MP3;
   video fallback could produce WebM/Matroska. A selection labelled MP3 or MP4
   cannot safely rely on those fallbacks.
5. The legacy engine checked existence/size and read the whole file into RAM;
   it did not fully decode output, verify codecs or compare duration/resolution.
6. A failed search candidate could become another video, or audio could switch
   to SoundCloud. This is inappropriate once a user has selected a particular
   title/source. Upload failure was also inside the candidate loop, allowing
   an uncertain upload to be followed by another candidate in some cases.
7. The handler reacted successfully immediately after `sendMessage`. It did not
   distinguish upload acceptance from a WhatsApp delivery acknowledgment.
8. There was no shared extraction/upload budget, bound selection ownership,
   explicit retry state, or token/quality selection expiry.
9. yt-dlp read host-level configuration by default. Current YouTube extraction
   also needs an explicitly enabled supported JavaScript runtime when using Node;
   yt-dlp enables only Deno by default. The repaired adapter enables the current
   Node executable and documents the matching challenge-solver requirement.

These are source-level findings. The reported intermittent production failure
cannot be attributed conclusively to one external service without production
logs and live provider access.

## Repaired command and interaction behavior

All original dispatcher names remain registered. Prefix parsing/runtime settings,
command permissions, the existing socket, pairing-code configuration, authentication
and unrelated commands are unchanged. No replacement bot or login path was added.
The supplied-source `sendReply` / `userSettings.prefix` names are not used by the
active handlers in this checkout; their existing socket reply and runtime-prefix
conventions were retained instead of inventing those objects.

| Commands | Behavior |
|---|---|
| `play`, `song`, `music` | Query or YouTube URL → thumbnail/menu → selection → actual file |
| `video`, `ytvideo`, `yt`, `youtube`, `ytv` | Query or URL → same menu; HD VIDEO opens actual qualities |
| `ytmp3`, `yta`, `ytaudio`, `audio`, `mp3` | URL → thumbnail/menu first → direct MP3 download/upload |
| `ytmp4`, `mp4` | URL → thumbnail/menu first → explicitly announced highest compatible available resolution → download/upload |
| `aio` YouTube routing | Uses the same direct-video path, preserving actual file delivery |

Menu content:

```text
ANIME MD • MEDIA SELECT

🎵 <title>
👤 <uploader>
⏱ <duration>
🔗 <canonical YouTube URL>

Choose a format below:
1. HD VIDEO
2. AUDIO MP3
3. VOICE TYPE

Reply to this message with 1, 2 or 3, or send:
<request-token> 2
Expires in 5 minutes.
```

This is an intentional **numbered-reply fallback**, not a claim of tested native
buttons. A bare number must quote the matching menu; otherwise it is left to
existing menu/quiz handling. The token+number form works without a command prefix,
including after a prefix change. Existing native-response decoding is exercised
with mocked native response payloads in dispatcher tests, but no native buttons
are newly emitted.

HD VIDEO sends one resolution selector. Only actual H.264/AAC MP4-capable formats
within known size estimates are offered. Separate H.264 video and AAC audio are
merged by FFmpeg; no unannounced lower-quality substitution occurs. MP3 is genuine
MPEG audio. VOICE TYPE is mono Ogg/Opus at 48 kHz with `ptt: true` and the correct
MIME. Final codecs, resolution, expected duration, byte size and complete decoding
are checked before upload.

Thumbnail retrieval is bounded to 10 seconds/2 MiB and a fixed YouTube thumbnail
host; redirects are prohibited. Failure is logged and explicitly identified in a
text menu, without pretending the thumbnail is the media file.

Selections are isolated by socket, chat and sender, with five-minute expiry,
random tokens, synchronous claiming, replay protection, bounded session storage
and a two-job host-wide budget. Only failed **pre-upload** jobs permit an explicit
`<token> retry`. Working, finished, unconfirmed and uncertain jobs cannot resend.
Terminal tombstones expire; pending selections are intentionally not persisted
across process restarts.

Progress edits the original text status. If editing fails, subsequent edits stop;
a single terminal text is used when necessary, not a stream of progress messages.
Baileys' documented per-message `mediaUploadTimeoutMs` is supplied. A matching
outgoing `messages.update` delivery status >=3 or `message-receipt.update` receipt
is needed for “Completed”; server acceptance alone is insufficient. After a
45-second receipt wait the state is unconfirmed, with no automatic resend.
A group participant delivery receipt confirms delivery to at least one recipient,
not necessarily to every group member.

## Provider, resource and security design

`youtube-engine.js` is an adapter over the existing local engine, not a second
set of login/dispatch infrastructure. `createProviderChain` implements ordered
fallback against the same canonical source and exact chosen height; it rejects
wrong-video and wrong-quality fallbacks. It is exercised with mocked adapters.

**Only yt-dlp is enabled as a download provider.** No live Hector API was supplied
or verified. Existing DavidCyril and other API helpers remain in place, but were
not enabled as speculative YouTube fallbacks. Adding another trusted adapter is
independent of session/UI code; do not accept provider endpoints from chat.
No claim is made that a second production download provider was verified.

Search uses the existing page helper, with existing yt-dlp search as a fallback.
It does not use search output as a substitute for downloadable media. Transient
provider errors get at most one application retry with exponential backoff;
format/restriction/size failures do not loop blindly. yt-dlp also retains its
existing bounded transport retries. Uploads have no application retry.

User URLs are restricted to canonical YouTube video IDs, including Shorts and
music links. Credentials, custom ports, local IPs, lookalike hosts, playlists and
arbitrary schemes are rejected. Tracking/query parameters are stripped. Processes
use argument arrays, never a shell. Host yt-dlp configuration is ignored. FFmpeg
can read only local file/pipe protocols. Filenames are sanitized, actual temp
paths are generated by `mkdtemp`, media remains file-backed, and cleanup occurs
on failures and after the upload consumes the file.

Final size uses `downloads.maxFileSizeMb` (50 MiB default). Aggregate temporary
storage is monitored at three times that cap per active job, including intermediates;
checks are periodic, so instantaneous filesystem use can overshoot before a process
is killed. Two jobs therefore need at least six times the final-size cap plus OS
headroom. Each subprocess has a configured hard timeout. Progress logs use safe
stage/error codes rather than signed URLs, cookie paths or raw provider stderr.

## Dependencies evaluated / installed

**No npm dependency was added, removed or upgraded.** `package.json` and
`package-lock.json` remain unchanged and consistent. `npm ci` installed 134
packages from the existing lockfile. `npm audit --omit=dev`: **0 vulnerabilities**.
`npm ls --depth=0` resolves the expected direct versions, including Baileys rc14;
it also labels sharp's locked optional WASM packages `@emnapi/runtime@1.11.3` and
`@img/sharp-wasm32@0.35.5` as extraneous on this host. No dependency was promoted
or removed to suppress those optional-package labels.

- `npm view ytscraper ...` returned registry **E404**. No exports, API methods or
  install command were invented, and this nonexistent registry package was not installed.
- `yt-search@2.13.1` exists (registry modification date 2025-05-02). Its CommonJS
  README documents search, single-video and playlist metadata, not media download.
  It is **not an existing dependency in this checkout**. Installing another
  search stack would overlap the working helper/yt-dlp search, so it was not added.
- Sandbox verification tools installed outside Git in `/home/user/.venv`:
  `yt-dlp==2026.10.21`, its matching `yt-dlp-ejs==0.8.0`, and
  `imageio-ffmpeg==0.6.0` supplying FFmpeg **7.0.2-static** for local media tests.
  The imageio package is test tooling, not a production bot dependency.
- The installed yt-dlp CLI's help confirms `--js-runtimes node:<path>` support.
  Its verified `default` Python extra includes the matching EJS solver. The
  production installation instructions use native FFmpeg and `yt-dlp[default]`,
  not an unverified npm extractor or an overlapping binary wrapper.

## Files changed

| File | Purpose |
|---|---|
| `commands/source-commands.js` | One delegation to the shared download flow; selection entry point; remove superseded duplicate logic/imports |
| `system/handler.js` | Route bound replies through existing public/self access control before quiz/menu fallback |
| `system/lib/youtube-flow.js` | Metadata/thumbnail-first interface, ownership/state/expiry, progress, upload and receipt handling |
| `system/lib/youtube-engine.js` | Strict local adapter, compatible formats, real file output, subprocess/resource limits, conversion, integrity, provider-chain fallback |
| `system/lib/local-downloader.js` | Reuse existing tool/search/provisioning infrastructure; ignore host config and optionally enable the current Node JS runtime |
| `commands/downloader-extended.js` | Keep `aio` YouTube routing direct rather than stopping at the new menu |
| `config.js` | Correct the FFmpeg requirement comment; settings and authentication values unchanged |
| `scripts/youtube-check.js` | Real host-side inspect/download/validate diagnostic with cleanup, no WhatsApp login/upload |
| `test/youtube-flow.test.js` | Mocked providers/socket/receipts covering state, ownership, selections, failure, concurrency, fallback |
| `test/youtube-engine.test.js` | Real process boundary and actual FFmpeg tests with generated media; no YouTube-network dependency |
| `test/youtube-dispatch.test.js` | Real dispatcher callback and alias flows with only provider/socket boundaries mocked |
| `test-support/command-harness.js` | Supply the new provider boundary and valid video IDs while continuing to run real flow/dispatcher code |
| `test/source-integration.test.js` | Replace three obsolete immediate-download/cross-source-substitution assertions with broader new flow/engine/dispatch coverage |
| `test/whatsapp-command-audit.test.js` | Valid fixture URLs and allow the deliberately tested thumbnail text fallback in the broad command sweep |
| `DEPLOYMENT.md` | Accurate tool requirements, Termux/native setup, limits, host checks, restart and manual acceptance instructions |
| `YOUTUBE-DOWNLOAD-REPAIR.md` | This findings and verification report |

## Test results

Final runs after all implementation changes:

| Check | Result |
|---|---|
| `node --test test/youtube-*.test.js` | **42 passed; 0 failed; 0 skipped** |
| `npm test` | **769 passed; 0 failed; 1 skipped** (770 total including nested tests) |
| Existing skipped test | `the real supervisor keeps a worker process alive and respawns it`; existing opt-in supervisor test |
| `npm run lint` | **104/104 JavaScript files passed syntax checks** |
| `npm run smoke` | Passed; configuration validated without opening WhatsApp |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `git diff --check` | Passed |
| Command registry checker | Passed: 144 commands, 302 execute names/aliases, 23 complete categories |
| Menu sync audit | Passed: no stale, duplicate or dead menu entries |
| `npm run audit:source` | Could not run: required original-source ZIP archive is absent |
| Live yt-dlp YouTube probe | Failed with TLS EOF under sandbox network restrictions; no live media downloaded |
| Actual handset rendering, playback and WhatsApp delivery | Not run: no authenticated connection/network access |
| Termux execution | Documented, not run on an Android host |

Required scenario coverage:

| Requested scenarios | Evidence |
|---|---|
| 1–5: URL, spaced search, Shorts, missing args, invalid URL | Flow URL/parser/input tests and real dispatcher fixtures |
| 6: no search results | Terminal no-result flow test, no source substitution |
| 7: timeout | Flow failure test plus real subprocess timeout kill |
| 8: malformed JSON | Actual fake metadata executable emits invalid JSON; local parser rejects it |
| 9–11: missing audio, missing video formats, unavailable quality | Stream-capability tests and actual adapter rejects absent audio/quality; no API audio URL is assumed |
| 12: expired/inaccessible source | Actual subprocess returns 403 plus mocked inaccessible download failure; never uploads |
| 13: empty/corrupt file | Actual executable writes empty/JSON output; real FFmpeg rejects truncated magic-looking MP4 |
| 14: size limit | Actual source file too large, final size check and storage-watchdog process kill |
| 15: WhatsApp upload failure | Socket throws after upload attempt; cleanup and no-repeat behavior tested |
| 16: thumbnail failure | Retrieval/send fallback and continued media upload tested |
| 17–19: MP3, HD VIDEO, voice | All callback paths; real local media conversion for MP3, H.264/AAC MP4 and Ogg/Opus |
| 20: unrelated user | Both wrong-user and wrong-chat attempts rejected |
| 21: concurrent requests | Two concurrent jobs; bounded third request fails safely |
| 22: repeated clicks | Simultaneous and post-completion replay tests; one download/upload |
| 23: safe retry | Explicit retry only before upload, successful cleanup; uncertain upload cannot resend |
| 24: aliases | Direct and selection aliases tested plus existing full public-command dispatcher sweep |

Additional checks cover receipt timing/early-receipt race, invalid quality selection
state, disabled edits, exact resolution/duration mismatch, canonical-source fallback
identity and refusal to silently downgrade quality. The local clip tests exercise
real files/processes; socket/provider mocks do **not** prove real YouTube or
WhatsApp success.

## Deployment / restart / final live acceptance

1. Deploy these files on Node 22 with the existing package lock: `npm ci`.
2. Follow `DEPLOYMENT.md` to install current yt-dlp with its matching EJS solver
   and native FFmpeg. Set absolute tool paths in `config.js`; verify both tools.
   For Termux use native packages and disable automatic Linux binary provisioning.
3. Keep session/auth/data directories untouched. Ensure writable temporary storage,
   adequate free space, and outbound YouTube/media/thumbnail/WhatsApp access.
4. Run `npm run lint`, `npm test`, and `npm run smoke` on the host.
5. Run `node scripts/youtube-check.js '<accessible YouTube URL>' info`.
   Then test `audio`, `voice`, and `video <an available height>` using the same
   script. These operations actually download/validate and then delete the file;
   they do not connect to WhatsApp or verify its delivery.
6. Restart the existing process manager once, or stop the old instance and run
   `npm start`. Do not start two copies on the same credentials.
7. In WhatsApp, test `!play <name>`, `!video <URL>`, audio selection, HD/quality
   selection, VOICE TYPE, and direct `!ytmp3` / `!ytmp4` URLs. Confirm thumbnail
   order, actual playback, correct quality, a true voice-note bubble, and final
   delivery acknowledgment. Repeat with a second user to verify ownership.

Private/age/region restrictions, unavailable formats, missing JS solver components,
YouTube bot checks, expiring format availability, host storage and WhatsApp upload
limits can still prevent a particular download. Only supported H.264/AAC video
qualities are offered. No implementation promises every video; this repair reports
failures without false completion or silent source substitution.
