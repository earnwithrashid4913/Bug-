# AnimeMD source-command replacement report

## Verified result

The existing CommonJS dispatcher and categorized menu remain the only active command system. Old text-only anti-delete handling, old view-once media delivery, old automation command bodies, old group-tagging/bulk-action bodies, and replaced downloader bodies were removed/replaced rather than left active beside their replacements.

- **130 canonical menu commands, 235 execute names/aliases.**
- Every public dispatch case has a menu mapping; every menu alias has a dispatch case; no duplicate names/cases.
- Hidden `h`/`hidden` remain intentionally outside the public menu.
- **69/69 JavaScript files pass syntax checks.**
- **271 automated tests: 270 pass, 0 fail, 1 existing skip.**
- Changed production modules pass ESLint `no-undef`.
- Imports/exports are exercised through real module loading and execution tests.
- `git diff --check` passes.

This is an implementation and automated-test result, **not proof of live WhatsApp/provider availability or byte-for-byte source parity**. API responses and sockets are mocked in most command tests. The media-conversion test uses real Sharp, WebPMux and FFmpeg.

## Source → AnimeMD → replacement → verification

| Supplied source | Active command / implementation | Change | Verification |
| --- | --- | --- | --- |
| ai.js | ai/ask; loveai/love/dark; ia/groq | Existing AI helper extended with source romantic/free-chat system prompts, source temperatures/token budget and API errors; standard AI retained | Persona request tests + dispatcher sweep PASS; live Groq not tested |
| alive.js | alive | Uptime/image flow with scoped text fallback | Fallback + dispatcher PASS |
| ping.js | ping/p | Real awaited send timing, source latency image selection, same measured value on fallback | Timing/fallback/case/button tests PASS |
| antidelete.js + messageStore.js | antidelete/antisupp; message-recovery helper | Old text-only cache replaced with bounded per-socket/per-chat text/media recovery, owner delivery, view-once forwarding, TTL/eviction | Media recovery, socket/chat isolation, expiry tests PASS |
| anitlink.js | antilink | No-argument toggle plus existing explicit on/off/status; source URL detection and warning/removal pipeline | Handler-level delete/three warnings/removal PASS |
| antispam.js | antispam | Toggle plus source six-messages-in-five-seconds detection | Handler-level enforcement PASS |
| antimention.js | antimention/antigroupmention | Status/on/off plus source mass-mention and @everyone/@all detection | Handler-level enforcement PASS |
| antitag.js | antitag | Toggle plus source five-mentions threshold | Handler-level enforcement PASS |
| autoreact.js | autoreact/autoreaction | Full source default emoji set, custom emojis, status, on/off, existing-store persistence and non-command hook | Helper + actual handler hook PASS |
| autowrite.js | autowrite/autotype/fakewrite | Non-command composing → delay → paused flow, on/off/status; existing per-chat storage retained | Presence lifecycle PASS |
| autostatus.js | autostatus/autostatusview/autostatusreact | Source view/react/emoji/status settings and complete batch processing helper implemented | Helper tests PASS; **live routing BLOCKED by protected index.js filters**, detailed below |
| convert.js | toimg/sticker2img/img; tovid/sticker2vid; convert/converter | First-frame image conversion; static and animated sticker-to-video; isolated temp directories and cleanup; real MP4 instead of fake image-as-video fallback | Real conversion round-trip PASS |
| media.js sticker branches | sticker/s/stiker; take/steal | Existing image sticker preserved; video sticker conversion added; pack/author replacement preserves animation | Real video sticker and EXIF tests PASS |
| media.js collection branches | store/ad/vd/list/del | Existing RuntimeSettingsStore namespace, real stored bytes, circular-video option, exact deletion | Round-trip, path safety, persistence tests PASS |
| greet.js | greet/welcome/goodbye | Source welcome/goodbye/both toggles; explicit button on/off stays idempotent | Persisted handler-flow tests PASS |
| group.js basic actions | group/gname/gdesc/kick/add/promote/demote/lock/unlock/grouplink/linkgc | Existing Baileys calls preserved where equivalent; broken linkgc dispatch corrected | Canonical execution sweep PASS |
| group.js bulk actions | purge/kickall/kickall2/demoteall/autopromote; existing promoteall retained | Source batch purge/demotion and progressive kick flow; existing admin/bot-admin checks retained | Batch and denied-caller tests PASS; dispatcher sweep PASS |
| group.js protection switches + source index group-event logic | antidemote/antipromote | Source promotion/demotion reversal wired into existing group event module; self-event/cooldown guard prevents feedback loops | Event reversal/no-oscillation tests PASS |
| tag.js | tag/hidetag/ht; tagall/everyone | Source hidden/visible tagging, profile-photo preview, quoted text, group mentions, first-30 visible list | Actual handler-flow tests PASS |
| save.js | save/savestatus/downloadstatus | Separated from old vv alias; downloads, persists status, sends to connected owner before success confirmation | File persistence + owner delivery-order test PASS |
| vv.js | hey/vv/viewonce/revealonce/retrieve | Source private reveal flow with group acknowledgement and private errors; wrapper compatibility and existing audio support retained | Wrapped-media private delivery test PASS |
| delsudo.js | delsudo/removesudo/unsudo | Source number/mention/reply targeting and no-argument list; existing phone store and owner gate preserved | LID-resolution/removal/denial tests PASS |
| sudo.js | sudo/addsudo/makesudo | Source mention/reply/number targeting and already-sudo response; existing LID→phone resolver reused | Real store/handler-flow tests PASS |
| sudolist.js | sudolist/listsudo/sudos | All aliases registered, same existing store, list responses | Dispatcher sweep PASS |
| warning.js | warnings/warns | Mention-specific anti-link/spam counts and per-user/group reset using existing warnings history | Warning reset and count test PASS |
| mode.js | private/self/public; mode/botmode retained | private routes to existing self implementation; **owner authorization unchanged** | Private alias/denied non-owner test PASS |
| setname.js | setname | Source 2–30-character validation; saves runtime display name and retains WhatsApp profile update | Dispatcher sweep; dynamic menu name exercised |
| setprefix.js | setprefix | Existing persisted parser/button-aware implementation retained; source command is already equivalent except existing four-character support is preserved | Prefix/case/button regression PASS |
| play.js | play | Source Hector download flow using existing YouTube search helper | Dispatcher/API-error-path tests PASS |
| ytmp3.js | ytmp3/audio/mp3 | Source Hector audio flow and URL validation | Dispatcher/API-error-path tests PASS |
| ytmp4.js | video/ytmp4/mp4/ytvideo | Source descending quality selection and media delivery | Quality-selection test PASS |
| uploader.js | upload/mirror/host | Four source mirror services; nonfunctional quoted-media placeholder replaced with existing real upload helper | Delegation + dispatcher tests PASS |
| url.js | url/tourl/imgtourl/imageurl/uploader | Existing real uploader reused, including quoted audio/video/document; exposed ImgBB key NOT embedded | Import/dispatch/media-delegation checks PASS; live host upload not tested |
| utils.js | getpp/pp/profilepic/avatar, setpp, jid/chatid, idch/cekidch | Mention/reply precedence fixed; owner-authorized group setpp with bot-admin check; group details expanded; current-newsletter ID supported alongside existing invite URL lookup | Existing API/dispatcher tests PASS |
| tools.js | fancy/encrypt/encrypt2/tempmail/getmail; tools/utils help retained | Source API routes and responses, explicit errors; no empty button-handler placeholder imported | Dispatcher/API-error tests PASS |
| BotTracker.js | bot-tracker helper attached to existing dispatch | All stats/load/save/start/stop/heartbeat/history/uptime/force methods implemented using existing settings store; optional HTTPS reporting | Persistence/history/stop tests PASS |
| safeSend.js | safe-send helper used by automation | Delay/retry, reaction, presence, cleanup/stat/reset helpers; per-socket isolation and unref timer | Automation tests + no-undef/import checks PASS |
| helpers.js / menu.js | existing UI/menu plus presentation helper | Mathematical-bold marked WhatsApp headers, GoatMods footer, real command metadata; no second menu loader | Styling preservation + interactive regression PASS |

## Protected boundaries requiring explicit permission

### 1. Live AutoStatus delivery

`index.js` contains two existing message routes which discard `status@broadcast` before `handleMessage` is called (currently around lines 293 and 538). The source-compatible helper and its handler branch are implemented and tested, but cannot receive live statuses through those filters.

A minimal routing change must let status events reach the existing handler while retaining the check for absent message content. This needs permission because it is in the protected main/Telegram-paired event-routing file. No parallel listener was introduced to evade that restriction. The command/menu does not claim that this blocked route is active.

### 2. Telegram title/header styling

Telegram rendering lives in protected controller files. Those files were not modified. Mathematical-bold styling applies to marked headings sent through the unprotected WhatsApp UI helper, not every Telegram message. Display-only changes inside the protected Telegram controller require explicit permission.

### Preserved security differences, not silently changed

Source single-user private mode allows sudo users, whereas AnimeMD's existing self-mode gate permits the owner. That authorization policy remains unchanged. Sudo storage still contains validated phone numbers; LID targets must resolve through the existing mapping helper rather than introducing raw-LID membership or replacing the security model. Source unguarded admin operations were not used to bypass AnimeMD's admin/bot-admin gates. Source defaults did not overwrite existing group settings.

## Compatibility and persistence decisions

- CommonJS helper modules connect to the existing dispatcher; they are not another command architecture.
- Existing settings, automation, group and warning stores are reused. No source `db.json`, second main database, migration or overwrite was introduced.
- Recovery extends the existing in-memory cache with actual media bytes, bounded at 1,000 messages/32 MiB and one-hour TTL, isolated per socket and chat. It does not retain a second old text-only cache.
- Stored media and saved statuses are under the configured runtime data directory; generated filenames prevent path traversal.
- FFmpeg output is MP4 for WhatsApp video compatibility; animated WebP frames are decoded with Sharp because many FFmpeg builds cannot decode that input directly. No image-byte video fallback.
- Source utility functions are integrated into AnimeMD helpers rather than copied with incompatible imports. Existing standard AI, extra downloader commands, explicit menu buttons, image-sticker support and unrelated commands remain active.
- Source BotTracker starts lazily on the first completed recognized dispatch, not in protected connection lifecycle code. It stores aggregate local counts, bounds history, saves after dispatch, and uses unref periodic timers. Remote reporting is opt-in via `BOT_API_URL`; no source dashboard remote-command polling was imported.
- Source local menu.jpg/menu.mp3 assets were not provided. The existing real interactive menu and fallback are retained instead of adding missing-file-dependent menu logic.
- All source reactions use actual transport calls; no fake provider or media implementation was added to production. Mocks are confined to tests.

## Dependencies

- `package.json`, lockfile and Baileys **7.0.0-rc14** unchanged.
- No new npm dependency. Existing Sharp/WebPMux and YouTube/upload helpers are reused.
- New runtime requirement for source video conversion: **FFmpeg with libwebp/libx264**. Sandbox tests used real FFmpeg 7.0.2; the deployment host must provide `ffmpeg` on PATH. `DEPLOYMENT.md` documents installation. Missing FFmpeg produces an explicit failure, not bogus output.
- Exposed source credentials were not copied into the repository.

## Files changed (cumulative session)

Production:
- `system/handler.js`
- `system/group-events.js`
- `system/lib/ai.js`
- `system/lib/automation.js`
- `system/lib/menu.js`
- `system/lib/sticker.js`
- `system/lib/ui.js`
- `system/lib/source-commands.js` (new)
- `system/lib/stored-media.js` (new)
- `system/lib/message-recovery.js` (new)
- `system/lib/bot-tracker.js` (new)
- `system/lib/presentation.js` (new)
- `system/lib/safe-send.js` (new)

Tests/audits/documentation:
- `test/core.test.js`
- `test/whatsapp-buttons.test.js`
- `test/broadcast.test.js`
- `test/source-integration.test.js` (new)
- `test/source-replacements.test.js` (new)
- `test/source-handler-flows.test.js` (new)
- `scripts/command-registry-check.js` (new, audit only)
- `COMMAND-REGISTRY.md` (generated command/alias inventory)
- `COMMAND-INTEGRATION-REPORT.md`
- `DEPLOYMENT.md`

## Unchanged protected files

Git diff verifies no changes to `index.js`, root `config.js`, `system/config.js`, `system/security.js`, `system/session.js`, Telegram controllers/pairing manager, existing sudo/JSON/group-settings/runtime-settings store implementations, `package.json`, or `package-lock.json`. No `.env` replacement. Existing pairing/session/Telegram tests pass, but no real authenticated pairing was attempted.

## Reproduce verification

```sh
npm run check
node scripts/command-registry-check.js
node scripts/command-registry-check.js --markdown
node --test test/source-replacements.test.js test/source-handler-flows.test.js
```

`COMMAND-REGISTRY.md` accounts for every active public command and alias. Static presence and automated mocked execution must not be confused with successful real-world third-party API calls.
