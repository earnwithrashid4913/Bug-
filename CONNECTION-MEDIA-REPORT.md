# Connection media — implementation report

Implemented on `arena/01a094a7-bug`. This report describes **only this follow-up**; previous source-integration and status/title changes remain intact.

## 1. Architecture inspected

Reviewed the configuration loader, startup/supervisor wiring, both WhatsApp connection routes, Telegram controller API transport and success/edit flow, pairing-manager open callbacks and native pairing call, phone-number helpers, controller-store schema/tier paths, protected security definitions, media utilities, presentation/button helpers, deployment instructions, package/lock files, command registry, and relevant acceptance/regression tests. Inventoried the existing system/test/scripts tree before extending the existing routes.

Existing extension points were already present: `notifySessionConnected()`, `sendConnectionSuccess()`, `connectionCardSent`, and `pairedSelfWelcomeSent`. They were reused rather than rebuilding pairing or connection handling.

## 2. Protected identity and boundaries

`system/security.js`, `CANONICAL_IDENTITY`, protected-environment assertions, signed-identity grants, developer/owner authorization, and deployer restrictions are unchanged.

**Literal spelling discrepancy:** the protected developer/organization constant is **`F!xa Dev`**; the canonical author is **Rashid Hussain**. No protected constant was renamed to “Only Fixa Dev.” New welcome captions use the authenticated account's own display name/JID, never a configured privileged phone number.

## 3. Existing files changed in this follow-up

| File | Change |
|---|---|
| `config.js` | Two independently configured optional-media sections |
| `system/config.js` | Normalize/freeze those sections; invalid optional endpoint does not break startup |
| `index.js` | Wire anime options into the existing controller; extend self-chat success helper; contain notification errors |
| `system/lib/telegram-controller.js` | Premium success text, URL-video method using existing API transport, post-success asynchronous enhancement and dedupe |
| `package.json` | One pinned phone-metadata dependency |
| `package-lock.json` | Only that dependency's root/package entries added |
| `.gitignore` | Ignore user-supplied connection MP4 files |
| `DEPLOYMENT.md` | Configuration, storage, privacy and runtime instructions |

Unrelated pre-existing modified files in the working tree were not edited for this task.

## 4. New files

- `system/lib/anime-library.js` — optional client, metadata validation, country lookup, weighted choice and short-lived recent IDs.
- `system/lib/connection-welcome.js` — authenticated-self target validation, Gojo caption and optional local/remote welcome delivery.
- `test/connection-media.test.js` — 42 focused unit/error-path tests.
- `test/connection-media-integration.test.js` — 11 controller/callback/storage tests.
- `media/connection/README.md` — placement instructions; no bundled video.
- `CONNECTION-MEDIA-REPORT.md` — this report.

Total scope: **8 existing files changed, 6 new files**.

## 5. Existing systems reused

- The same Telegram controller, `api()` transport, fetch implementation, HTML escaping and 15-second Telegram API timeout.
- The same serialized flow-edit queue and connected buttons.
- The same pairing manager, connection callbacks, native Baileys sockets and auth paths.
- The same primary/paired welcome guards and menu-button helper.
- Existing `font()` presentation helper and `readLimitedBuffer()` for bounded remote welcome bytes.

No additional bot instance, socket system, connection listener, session manager, command dispatcher, database or background polling loop was added.

## 6. Configuration location and priority

Edit **root `config.js` only**, using a private deployment copy when adding secrets. The existing loader supplies the frozen runtime options. There is **no `.env` loader or environment override for these features**.

The checked-in configuration is:

```js
telegramAnimeEdit: {
  enabled: false,
  libraryApi: '',
  apiKey: '',
  gender: 'mixed',
  quality: 'top',
  avoidRecent: 5,
  timeoutMs: 15000
},
connectionWelcomeVideo: {
  enabled: true,
  source: 'local',
  path: './media/connection/welcome.mp4',
  url: '',
  timeoutMs: 15000
}
```

Optional settings are normalized safely: only literal `true` enables; recent IDs clamp to 0–50; timeout clamps to 100–60,000 ms. Missing sections default off. Invalid enabled URLs are rejected during optional delivery, not during startup or pairing.

## 7. OFF behavior

`telegramAnimeEdit.enabled: false` **or** an empty `libraryApi` causes **zero Anime Library requests, zero anime-video sends and no feature error log/message**. The normal Telegram success message/photo still uses the existing Telegram API, as before.

`connectionWelcomeVideo.enabled: false` independently disables the new WhatsApp video. The existing welcome image/text/menu remains available. Neither flag controls the other feature.

## 8. ON setup

Set `telegramAnimeEdit.enabled` to `true`, then set `libraryApi` to **your own complete direct HTTPS `/api/anime/random` endpoint**. There is no hardcoded service domain. Supply `apiKey` only if your server requires it; it is sent as:

```text
Authorization: Bearer <your private API key>
```

It is not appended to query parameters or sent to Telegram. Keep real credentials out of Git. API redirects are rejected to avoid forwarding this header.

For WhatsApp, place your authorized MP4 at the configured local path. Alternatively set `source: 'url'` and `url` to a trusted, direct public HTTPS MP4. Restart the existing bot to load config changes. No extra service is started by ANIME MD; the library server remains external.

## 9. External API contract and validation

Requests send:

```text
country=PK&gender=mixed&quality=top&avoid_recent=5
```

After successful deliveries, an additional optional `exclude_ids` comma-separated parameter contains the recent IDs. A library can honor it to avoid repeats even when returning just one candidate.

Supported bodies: one video object, an array, `{ data: object }`, `{ data: [...] }`, `{ videos: [...] }`, or `{ items: [...] }`.

Example response schema (illustrative only; replace the reserved example URL with your authorized hosted asset):

```json
{
  "enabled": true,
  "id": "gojo-01",
  "videoUrl": "https://media.example/gojo-01.mp4",
  "country": "PK",
  "gender": "male",
  "anime": "Jujutsu Kaisen",
  "character": "Gojo",
  "label": "✦ Limitless • Gojo ✦",
  "quality": 9.5,
  "views": 125000
}
```

Required: `enabled: true`, a safe nonempty string ID, and a public HTTPS `videoUrl` without embedded credentials. Disabled/malformed entries are ignored. Optional strings are length-limited and control/bidirectional-control characters are removed. Missing country means `WORLDWIDE`; missing gender means `mixed`; missing/invalid numeric quality/views use safe defaults. Quality is clamped to 0–10 and views to 0–10¹². Duplicate IDs are collapsed. At most 100 entries in a response are considered; JSON is limited to 512 KiB.

Only authorized hosted assets should be returned. Telegram must be able to fetch the video URL without the library API key. No TikTok scraping, downloader bypass, watermark removal or content-rights bypass was implemented.

## 10. Phone-only country selection

`libphonenumber-js/min` resolves ISO country metadata from the normalized international number. No IP address, GPS, Telegram profile location or geolocation API is used. The external server receives only the inferred country and selection controls, **not the phone number**.

Tests cover PK, IN, GB, AE, SA, JP, KR, US, unknown and empty inputs. Shared calling-code territories are resolved by metadata rather than guessing: the tested `+44 7911…` example resolves to GG, not GB.

A country-specific request is made first. If it contains no suitable country/gender candidates, a second request uses `WORLDWIDE`. Unknown numbers request `WORLDWIDE` directly. HTTP 204/404 are catalog misses; operational HTTP/auth/DNS/JSON failures are safely logged and skipped rather than repeatedly retrying.

## 11. Gender and weighted selection

`male` and `female` prefer their configured gender while accepting generic `mixed` assets. `mixed` first randomly chooses an available gender bucket, preventing the larger gender catalog from always dominating.

For `quality: 'top'`, each candidate's positive weight is:

```text
1 + 2 × quality + log10(views + 1)
```

This favors stronger quality/view metrics while retaining randomness. `quality: 'normal'` uses equal weights within the selected gender pool. The existing phone-number pairing validator was not replaced by country detection.

## 12. Premium success and video labels

The existing styled connected box now includes:

- `ANIME-MD • LINK COMPLETE`
- `Pairing Completed Successfully`
- `WhatsApp Connected`
- safely displayed paired number and optional Telegram username
- `Session: ACTIVE`, `Secure Session`, `System Ready`

Public pairing continues to edit its original group message with a **masked number**; private pairing keeps its private number display. Existing connected buttons remain intact. If a success photo/edit cannot be delivered, a text fallback is attempted. No optional video starts unless a success delivery completes.

The API's label is preferred. Missing labels use a small styled anime/character fallback, not a label database. Telegram HTML escaping is preserved. The extra video caption contains the label, not the paired phone or private owner information.

## 13. Anti-repeat and failure isolation

Recent IDs are stored only in `recentVideoIds`, default length 5, configurable to 0–50. Fresh candidates are preferred when available; a one-item catalog can still repeat when it offers no alternative. Recent IDs are updated only after successful video delivery, expire lazily after 30 minutes without success, and reset on process restart.

A bounded in-memory queue (20 pending deliveries) serializes selection, so simultaneous connections do not all choose the same fresh item. Overload skips the optional enhancement. A per-account process-local guard prevents reconnects from retrying/repeating optional Telegram video attempts.

API timeout is per request (country and fallback can each use it); Telegram sending uses the existing 15-second API timeout. These operations are detached from success notification completion and never awaited by the critical connection-open path. Errors are contained and logged with fixed internal codes, not provider bodies, URLs, keys, tokens, session data or raw exception messages.

## 14. Persistence and privacy

**No new database schema, table, media history, binary library storage or stored Telegram message objects.** The existing successful-pairing number record still works normally; integration tests inspect that actual JSON file and verify no video ID, URL, label, message object or API/token data is added.

Telegram receives the hosted video URL directly; ANIME MD does not download it. Remote WhatsApp welcome bytes use transient memory capped at 50 MiB. No new temporary or permanent download file is created by these helpers. Baileys retains its own unchanged upload/thumbnail internals. The optional helper modules have no filesystem write calls.

## 15. WhatsApp own-chat welcome

Supply **`./media/connection/welcome.mp4`** yourself. No video was supplied, generated or committed in this task. The local MP4 is ignored by Git and should live on your persistent deployment disk.

The welcome goes only to the authenticated `socket.user.id`, after stripping Baileys' device suffix. Numeric private `@s.whatsapp.net` and actual own `@lid` JIDs are accepted; groups, broadcasts, statuses, missing identity and guessed/configured owner destinations are rejected. A LID is not falsely displayed as a phone number: the caption says `Unavailable` when no phone-form own JID is supplied.

The Gojo-themed caption includes the authenticated own name/number, connected state, Limitless/Infinity/ANIME-MD status, a short motivational thought and system-ready panel. The existing menu follows. Successful video replaces the welcome image; missing/invalid/failed video falls back to the image/text/menu.

Existing `connectionCardSent` and `pairedSelfWelcomeSent` still enforce once-per-process/account attempts. A failed menu no longer resets a successful media attempt. Duplicate opens/reconnects do not repeat the video; **a process restart resets these existing in-memory guards**, so a restored session may receive one welcome again. No persistent dedupe table was introduced.

## 16. Pairing, permissions and feature preservation

Native pairing remains:

```js
const code = await session.socket.requestPairingCode(number);
```

The real manager's `connection === 'open'` callback is still the only production trigger for the paired success path. Code generation does not claim success. No fake production pairing codes, alternate pairing API or new listener were introduced.

Normal **1**, Premium **3**, VIP **unlimited** database-driven limits, verification, owner/admin access, 24-hour blocking, `/start`, menus, pair controls and buttons are unchanged. Existing command aliases, status view/reaction routing, antidelete and media commands remain intact.

Baseline hash comparisons passed for security, session handling, pairing manager, controller store, pairing-number helper, command handler, automation, button/UI helper and group events. Listener/controller/manager construction counts are unchanged: one primary and one manager connection listener registration site, two message-upsert registration sites, one controller and one pairing-manager construction site.

## 17. Executed checks and results

| Check | Result |
|---|---|
| New targeted unit/integration tests | **53 passed, 0 failed** |
| Final `npm run check` syntax | **75/75 files passed** |
| Final full regression suite | **326 tests: 325 passed, 0 failed, 1 existing skip** |
| Command registry | **130 canonical commands, 235 unique names/aliases; no duplicates/missing mappings** |
| `npm run smoke` | Dry-run config startup passed; no WhatsApp connection opened |
| `npm audit --omit=dev` | **0 vulnerabilities reported** |
| `git diff --check` | Passed |
| Baseline/protected/static scans | Passed; no new listeners, socket/controller systems or media filesystem writes |

The existing skip is the real supervisor worker-alive/respawn test. Test logs in this workspace: `/home/user/media-targeted-final.log`, `/home/user/media-full-final.log`, `/home/user/media-smoke.log`.

New tests cover OFF and empty endpoint; enabled valid/invalid URLs; country and worldwide fallback; gender/weights; recent-ID bounds/expiry; concurrency/queue limits; HTTP/auth/DNS/timeout/JSON/size/metadata/Telegram failures; success-before-media ordering; public number masking; DB non-persistence; own-JID checks; local/remote welcome; missing video; existing primary/paired callback guards and menu-failure dedupe.

**These are mocked network/socket tests exercising real production modules and extracted actual index callbacks, plus the existing pairing acceptance tests. They are not live authenticated WhatsApp/Telegram/provider delivery results.** No live pairing or hosted-video playback was attempted.

## 18. Dependencies and deployment requirements

- Added only **`libphonenumber-js@1.13.13`** (MIT), using its `min` metadata entry point. Reason: the existing helper splits calling codes but cannot reliably resolve ISO countries/shared numbering plans. No existing dependency equivalent was found; no handwritten country database was added.
- **Baileys remains `7.0.0-rc14`**; no unrelated dependency upgrades. Run `npm ci` after deploying the updated lockfile.
- Existing Node requirement: **20.9+**; checks here used Node **22.22.3**.
- Keep **FFmpeg on PATH** for existing media commands and Baileys thumbnail preparation. Checks here used FFmpeg **7.0.2** installed in the sandbox, not committed to the repository. The new helper does not transcode files. Use a short H.264/AAC MP4.
- Keep auth/session and existing database storage persistent, unchanged. Persist the local welcome asset separately; no library-media database is required.
- Allow outbound HTTPS to Telegram, WhatsApp, your trusted external library and media hosts. The library endpoint and remote welcome must not redirect. Telegram-hosted URL delivery must meet Telegram's own supported-format/size requirements; this client does not silently download/re-upload rejected anime assets.
- Allow RAM for the capped remote welcome buffer (50 MiB per concurrent welcome), plus existing Baileys upload buffers. Prefer small videos. Upload waiting is bounded and does not create retry loops; a remote download and upload have separate timeout phases.
- Public HTTPS validation rejects credentials, localhost/private IP literals and local hostname suffixes. It is **not DNS pinning or a network firewall**. Use only trusted/authorized providers, and enforce deployment egress restrictions if untrusted DNS/providers are in scope.
- Supply your own video and external API configuration to use the features. Without them, the optional anime feature is off and the welcome keeps its existing fallback behavior.
