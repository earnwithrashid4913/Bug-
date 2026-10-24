# ANIME MD — targeted YouTube regression recovery

> Current branch follow-up: [PLAY-VIDEO-REBUILD-REPORT.md](PLAY-VIDEO-REBUILD-REPORT.md). Earlier test counts and buffering descriptions below are historical.

> Current native-UI/provider-bounds follow-up: [YOUTUBE-INTERACTIVE-REPAIR.md](YOUTUBE-INTERACTIVE-REPAIR.md).
> This document retains its historical implementation and test evidence.

Date: 2026-10-24.

## Status and scope

The historical provider calls, response parsing and flexible local download path
have been recovered from Git and connected to the existing selection UI. This is
not another bot/extractor rewrite. **Live YouTube extraction and actual WhatsApp
delivery remain unverified** because the sandbox cannot reach the required hosts
and has no authenticated WhatsApp connection. The code-level recovery and tests
must not be described as a successful production download.

## Safe Git recovery record

Before editing:

- Branch: `arena/7e9c2081-bug` (remained on this branch throughout).
- HEAD: `2ee2396db3dfcc5bafd6c275e023b98fd7b301c8`, merge of PR #61.
- `git status --short`: empty. There was no uncommitted user work to overwrite.
- PR #61 was inspected through GitHub and Git. It is already merged; no attempt
  was made to reset main, delete branches, force-push, or close an unrelated PR.
- History was deepened using `git fetch --deepen=35 origin main`; no branch switch
  or repository-wide checkout/reset was performed.

Recovered source references:

| Commit | Evidence / recovered behavior |
|---|---|
| `be909d2115d7abaa519123540a4a6bfbb295174c` | Immediate pre-PR #61 baseline (merge #60): `commands/source-commands.js` used multiple search candidates, `local.downloadAudio` / `downloadVideo`, and flexible no-FFmpeg fallbacks |
| `dd6d11e062d782865811168a8ad9e356f33af76a` | Pre-PR #61 local engine provisioning changes; retained, not replaced |
| `8d3bb2fa32aefb0d591b50340683e8ba857ef74b` | Before PR #59: `commands/source-commands.js` contained the actual DavidCyril/Cobalt provider order and response parsing recovered here |
| `c07596006000a07bca7f0bee31643c74cce22488` | PR #59 changed the active flow to local downloads and dropped media API calls; that earlier change was not introduced by #61 |
| `e60a70ed86637b42afad35a547a6785801670441` | PR #61 implementation replaced the immediate handler with the new strict provider/UI flow |

The user identifies the previous behavior as better-working. Git establishes the
implementations and their order, **not** which external providers are operational
today. No archive-only Hector URL or missing original script was guessed.

## Exact regression findings

PR #61's default chain contained only `createLocalProvider()`. Its `inspect()`
called yt-dlp `getInfo()` and resolved FFmpeg **before the selection menu or any
download provider could run**. It rejected missing formats, absent FFmpeg and
unusable local metadata. Ordinary downloads also used newly strict H.264/AAC
format assumptions instead of the old engine's flexible format selection.

This removed the active route to the pre-PR #61 `downloadAudio`/`downloadVideo`
methods and their reduced-tool fallback. The older API helpers were still in the
repository, but not reachable from the default chain. PR #61 additionally forced
`--ignore-config`, which could discard host-level extractor/runtime/cookie
configuration that the previous engine had honored.

The reported text originates in `youtube-engine.js:classifyError()`. Its old
`/403|404|not available|.../` branch ran **before** format classification. Thus
`Requested format is not available` was wrongly presented as a video restriction.
HTTP 403, unavailable videos, bot checks and authentication were also conflated.
The `5\d\d` test could match unrelated numeric substrings rather than actual
HTTP status errors.

These are demonstrated code regressions. **The exact reason the two queries fail
on the deployment host cannot be established without its raw provider diagnostics.**
A screenshot of a generic classified error is not proof of a login requirement,
regional restriction, wrong search result, or currently unavailable video.

## Specific PR #61 changes reverted or bypassed

- Reverted the forced `--ignore-config` in `system/lib/local-downloader.js`.
  Compared with `be909d2`, this file now differs only by its **optional**
  `options.jsRuntime` argument support retained for the explicit-quality adapter.
  Default recovered local downloads do not set that option.
- Removed the yt-dlp-only default chain from `youtube-flow.js`; it now calls the
  historical API methods and the original local download methods via a small
  recovery adapter. The retained strict adapter is not the ordinary-download gate.
- Removed mandatory metadata extraction/FFmpeg availability as a prerequisite
  to reaching the ordinary API audio/video providers.
- Restored five-result searching using the same page helper and yt-dlp search
  fallback. Unlike the historical automatic next-result/SoundCloud substitution,
  another search result now requires explicit selection. SoundCloud is never
  substituted automatically, as required by the current request.
- Changed direct `ytmp4`/`mp4` back to automatic format selection, rather than
  requiring an enumerated exact resolution.
- Replaced the broad refusal classifier with specific format, network, timeout,
  dependency/runtime, malformed metadata, unavailable, bot-check, authentication,
  explicit age/geo restriction, HTTP denial and extractor error categories.

## Recovered provider selection and parsing

Recovered from `8d3bb2f:commands/source-commands.js`, reusing the **unchanged**
`commands/davidcyril-api.js` and `system/lib/net-tools.js` helpers:

- Audio: `dc.downloadYtAudio(canonicalUrl)` → configured/environment/fallback
  Cobalt servers → pre-#61 `local.downloadAudio(canonicalUrl)`.
- Automatic video: Cobalt → `dc.downloadYtVideo(canonicalUrl)` →
  `dc.aioDownload(canonicalUrl)` plus `pickUrl/pickTitle` → pre-#61
  `local.downloadVideo(canonicalUrl)`.
- Existing `{ ok, url, title }` and Cobalt `{ url, filename }` shapes are used;
  a missing/failed URL or invalid downloaded body falls through **before upload**.
- Existing DavidCyril endpoint pools and Cobalt configuration/environment order
  are preserved. No new service host, npm extractor or guessed API was introduced.
- The same canonical video URL is passed to every provider. Other search results
  are presented via `<token> sources` after a failed job and require explicit
  selection, followed by another format choice. A direct URL never changes source.
- Provider fallback ends before the WhatsApp upload starts. An upload exception
  cannot enter a second provider or blindly resend the file.

Restoring an API call is not a claim that the API is currently healthy. Both
API families remain subject to host-side verification, as do their existing
internal fallback endpoints and timeouts. A full failing historical API pool may
take longer than one `downloads.timeoutMs`; its per-endpoint bounds are unchanged.

## Improvements retained without blocking the old engine

- ANIME MD thumbnail-first numbered selection, original aliases and dispatcher.
- Metadata from the search result. Direct URLs use honest fallback labels instead
  of demanding local extraction merely to display a menu.
- HD VIDEO offers actual enumerated qualities when the optional strict lookup
  works, plus a separately labeled **Automatic video** option using the recovered
  providers. Failed optional lookup leaves automatic video usable. No hardcoded
  1080/720 claims or silent downgrade of an explicit selected height.
- Optional quality discovery does not auto-install binaries. Install the required
  tools explicitly if using manual resolutions; normal API downloads do not need
  those tools.
- Voice notes use FFmpeg to produce mono 48 kHz Ogg/Opus. If FFmpeg is missing,
  only VOICE TYPE fails with a specific message; ordinary audio/video remains
  available. Original non-MP3 audio can be sent with its actual MIME and a clear
  conversion-unavailable notice, not mislabeled MP3.
- Bounded download size, signature/container-stream checks, temporary-file cleanup,
  safe subprocess arguments, sender/chat binding, expiry, duplicate protection,
  two-job concurrency and progress edits.
- With FFmpeg installed, recovered output is fully decoded before uploading.
  Without it, signature/size/stream-marker checks are weaker than a complete
  decoder test. That limitation is intentional rather than blocking all downloads.
- The historical API helper uses a size-bounded buffer before staging the file;
  keep the 50 MiB default on low-memory hosts. It was not replaced with another
  extraction or streaming architecture. Unknown WebM is delivered as a file,
  never mislabeled `video/mp4`.
- WhatsApp acceptance is still distinct from delivery. Receipt-confirmed completion
  and no-blind-upload-retry behavior are retained. No fake “download completed”
  response is sent for a thumbnail or search result.

Pairing, credentials/session files, Baileys, unrelated commands, package manifest,
lockfile and the existing API client code were **not changed**. `config.js` changes
are comments only, correcting the restored provider/tool requirements.

## Files changed

| File | Reason |
|---|---|
| `system/lib/local-downloader.js` | Restore historical host-config behavior; retain original engine, formats, provisioning and cleanup |
| `system/lib/youtube-recovered.js` | Small adapter around recovered API order/parsers and pre-#61 engine; stage/validate files for retained UI |
| `system/lib/youtube-flow.js` | Use recovered default; seed from existing search metadata; optional quality lookup/auto fallback; explicit alternate-result consent |
| `system/lib/youtube-engine.js` | Correct misleading classification; keep exact-quality/voice tooling off the ordinary API critical path |
| `scripts/youtube-check.js` | Diagnostic now exercises the recovered provider path, accepts the reported queries and can isolate provider families |
| `test/youtube-recovery.test.js` | Regression tests for both queries, provider order/failure, aliases, actual staged bytes, no mandatory metadata/converter, cleanup, no blind uploads and classification |
| `test-support/command-harness.js` | Move its mocked service boundary to the recovered adapter; existing real dispatcher/flow still run |
| `config.js` | Comments only: APIs active again; FFmpeg no longer mandatory for every download |
| `DEPLOYMENT.md` | Correct recovered provider order, optional features, host diagnostics and limits |
| `YOUTUBE-DOWNLOAD-REPAIR.md` | Mark the old PR #61 report as superseded, not current proof of functionality |
| `YOUTUBE-ROLLBACK-REPORT.md` | Recovery evidence, limitations and deployment acceptance checklist |

## Automated verification

Environment: Node 22.22.3, npm 10.9.8. `npm ci` installed the existing lockfile;
**no npm dependency was added, removed or upgraded**. Sandbox-only tools installed
outside Git: yt-dlp 2026.10.21, its EJS solver 0.8.0 and imageio-ffmpeg 0.6.0
(FFmpeg 7.0.2-static). These are not added bot dependencies.

| Check | Result |
|---|---|
| `node --test test/youtube-*.test.js` | **77 passed, 0 failed, 0 skipped** |
| `npm test` | **804 passed, 0 failed, 1 pre-existing skip**, 805 total including nested tests |
| Existing skipped test | Real process-supervisor respawn test, opt-in in the existing suite |
| `npm run lint` | **106/106 JavaScript files passed** |
| `npm run smoke` | Passed; no WhatsApp connection opened |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Command registry / menu sync | Passed: 144 commands, 302 names/aliases, 23 complete categories; no stale/duplicate/dead menu routes |
| `git diff --check` | Passed |

Mocked-service regression tests cover both exact reported query strings, original
API parsing/order, primary failure followed by a real second adapter call, local
fallback, original ytmp3/ytmp4 aliases, thumbnail-first send ordering, optional
quality failure with successful automatic video, missing FFmpeg without breaking
audio, explicit alternate-result consent, staged file bytes consumed by the send
callback, cleanup, and upload exceptions without provider retries. They also
exercise precise classification of the old “format not available” regression,
TLS/DNS errors, HTTP 403/404/429/503, extractor failures and explicit restrictions.

The existing and new actual-FFmpeg tests use generated local clips to check real
process execution, output decoding, MP3/Opus generation and cleanup. **Those clips
and mocked socket callbacks are not evidence of live YouTube playback or handset
receipt.**

## Real network checks performed — failures, not passes

These operations used real services, not provider mocks:

1. `node scripts/youtube-check.js 'New FunkS Latest 10 minutes' audio`:
   page search and local search fallback failed; diagnostic classified `NETWORK`.
2. `node scripts/youtube-check.js 'memories hasan' audio`: same result.
3. Direct `BaW_jenozKc` audio check: DavidCyril, Cobalt and local fallback all
   attempted; final summary contained `NETWORK` for each provider.
4. Same direct video check: Cobalt, DavidCyril MP4, AIO and local fallback all
   attempted; final summary contained `NETWORK` for each provider.
5. Isolated HTTP probes: YouTube and DavidCyril returned `fetch failed` with
   `ECONNRESET`; Cobalt returned `ENOTFOUND`. DavidCyril's actual helper reported
   its TLS socket disconnected before the secure connection was established.

The sandbox allows only selected GitHub/package hosts. These failures cannot
prove the providers are down globally, that these videos require authorization,
or that the deployment host will behave identically. No usable real media was
downloaded here. Real WhatsApp upload, playback, receipt delivery and Termux
execution were not available for testing.

## Exact host-side acceptance procedure

Deploy this branch's changes to a staging instance first. Preserve all credentials
and session/data directories. Use Node 22 and the unchanged package lock:

```sh
npm ci
npm run lint
npm test
npm run smoke

# Same queries as the reported production failures; actual audio attempts:
node scripts/youtube-check.js 'New FunkS Latest 10 minutes' audio
node scripts/youtube-check.js 'memories hasan' audio

# Direct public URL (or another public video known to work on this host):
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' video

# Isolate provider families without changing chat behavior:
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio --provider=davidcyril
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' audio --provider=cobalt
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' video --provider=local

# Optional features after ordinary downloads work:
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' formats
node scripts/youtube-check.js 'https://www.youtube.com/watch?v=BaW_jenozKc' voice
# To test an exact height, use a height actually printed by formats:
# node scripts/youtube-check.js '<same URL>' video <available-height>
```

`info` only prepares the request and states where metadata came from; it is not
a provider availability test. Actual `audio`/`video`/`voice` runs print downloaded
byte size and selected provider, then clean up the file. No diagnostic script
opens a WhatsApp connection or verifies handset delivery.

Restart the existing process manager once, or stop its old instance and run
`npm start` using the existing pairing/session configuration. Do not run two bot
processes on the same credentials. In WhatsApp test:

- `!play New FunkS Latest 10 minutes` → AUDIO MP3.
- `!play memories hasan` → AUDIO MP3.
- `!video <public URL>` → HD VIDEO → automatic video, then (if available) an
  explicitly enumerated resolution.
- `!ytmp3 <public URL>` and `!ytmp4 <public URL>`.
- VOICE TYPE with FFmpeg installed; confirm a playable voice-note bubble.
- Thumbnail before media, correct title/source, no duplicate upload after repeated
  responses, correct user binding, and real recipient delivery acknowledgment.

The recovery is ready for those host checks, but the user's final live acceptance
criterion is **still pending**, not declared passed. If a provider fails there,
retain its classified diagnostic and troubleshoot the actual TLS/DNS/HTTP/extractor
cause; do not default to telling the user to supply cookies.
