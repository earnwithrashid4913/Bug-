# ANIME MD — audit + targeted repair report

Branch `arena/01a0b9b4-bug`, commit `cdf6baf`. 18 files changed, 1234 insertions(+), 212 deletions(-).
No architecture was replaced: every fix reuses the existing pairing manager, session-status model,
command registry, dispatcher and Telegram controller.

---

## 1. Files changed

| File | What changed |
|---|---|
| `system/lib/telegram-pairing-manager.js` | `listAllSessions()` is now `async` — the call contract its consumers rely on. |
| `system/lib/telegram-controller.js` | Role-aware number visibility (`VIEWER`, `displayNumber`, `viewerRoleFromAccess`, `viewerRoleOf`), `readAllSessions()`, `sessionStats()`, `countLabel()`, `isInternalError()`/`internalErrorBox()`, and rewritten `connectedBox`, `activityBox`, `systemStatusBox`, `sessionsBox`, `statusBox`, `overallStatusBox`, `adminPanelBox`, `ownerPanelBox`, `sessionsMarkup`, `replyWithError`. |
| `index.js` | The `listAllSessions` binding passed to the controller is `async`, matching the manager. |
| `system/lib/menu.js` | `commandIndex(categories, prefix)` — renders the full registry index; `aio` registered (category `downloader`, aliases `allinone`, `alldownload`). |
| `system/handler.js` | Root `!menu` now emits the complete command index (chunked), numeric reply maps to a **visible** category, `!aio`/`!allinone`/`!alldownload` dispatch to `handleAioCommand`. |
| `commands/downloader-extended.js` | New `!aio` all-in-one downloader (`AIO_ROUTES`, `aioKindOf`, `sendAioMedia`, `aioGenericDownload`, `handleAioCommand`). |
| `COMMAND-REGISTRY.md` | `aio` row added to the public mapping table. |
| `test-support/telegram-display.js` | NFKC helpers so bold Unicode in card bodies can be asserted as plain text. |
| `test/telegram-sessions-button.test.js` *(new, 12 tests)* | Sessions-button contract regression suite. |
| `test/aio-downloader.test.js` *(new, 6 tests)* | `!aio` routing/usage/fallback tests. |
| 7 existing test files | Assertions updated for the new card wording, the menu index, and the registry surface counts (143→144 commands, 269→272 executable names). |

## 2. Issues fixed

1. **Sessions button crash — `this.pairing.listAllSessions(...).catch is not a function`.**
   Root cause: the manager returned a plain array while the controller treated it as a Promise.
   Fixed at both ends (manager is `async`; the controller `await`s) instead of deleting the `.catch()`.
   `readAllSessions()` accepts a Promise *or* a sync array, so a host wiring either shape keeps working,
   and an unexpected shape throws `SESSIONS_UNAVAILABLE` rather than rendering a fake empty list.
2. **Raw JavaScript leaked into user cards.** `replyWithError()` now classifies internal faults
   (`TypeError`, "is not a function", bad property reads, …) and renders one clean card;
   the full error still goes to the operator log.
3. **Duplicated state on the CONNECTED card.** Removed the `LINK COMPLETE / Pairing Completed /
   WhatsApp Connected / Session ACTIVE / Last Event / Last Update / System Ready` pile-up and the
   duplicated Roman-Urdu line; one line per fact now.
4. **`systemStatusBox` reported one process as three components** ("Telegram Bot", "Controller",
   "Pairing Service"). Verified in `index.js`: the bot and the controller are the *same* process, so
   the card now has one BOT line (real polling flag) plus a probed PAIRING line, and
   Public Mode / Premium Only moved into a CONFIGURATION block.
5. **Fake `0` values.** `countLabel(null|undefined|'')` → `Unavailable`. Session/queue/user counters
   start as `null` and are only replaced by a real read; `.catch(() => [])` swallows were replaced by
   logged failures. A degraded system now renders `SYSTEM DEGRADED`, never `SYSTEM OPERATIONAL`.
6. **`!menu` showed a stale manual list.** It now renders the authoritative registry index.
7. **Number visibility was decided per call site.** Centralised in one role-aware rule (below).

## 3. UI changes (Telegram)

All cards keep the existing ANIME MD box style; bold Unicode is applied to labels only.

**CONNECTED** (`notifySessionConnected`):
```
╭━━〔 𝐀𝐍𝐈𝐌𝐄 𝐌𝐃 • 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃 〕━╮
┃ ✦ 𝐋𝐈𝐍𝐊 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄 ✦
┃ ✅ 𝐏𝐀𝐈𝐑𝐈𝐍𝐆 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄
┃ 🟢 𝐖𝐇𝐀𝐓𝐒𝐀𝐏𝐏 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃
┃ ──────── 𝐒𝐄𝐒𝐒𝐈𝐎𝐍 ────────
┃ 📱 𝐍𝐮𝐦𝐛𝐞𝐫: +91 987 6543061        (owner) / +91 ••••• 061 (user)
┃ 🟢 𝐒𝐭𝐚𝐭𝐮𝐬: 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃
┃ ⏱️ 𝐔𝐩𝐭𝐢𝐦𝐞: 01h 00m 00s
┃ 🔄 𝐑𝐞𝐜𝐨𝐧𝐧𝐞𝐜𝐭𝐬: 1
┃ ──────── 𝐒𝐘𝐒𝐓𝐄𝐌 ────────
┃ 🔐 𝐒𝐞𝐜𝐮𝐫𝐞 𝐒𝐞𝐬𝐬𝐢𝐨𝐧
┃ ⚡ 𝐒𝐘𝐒𝐓𝐄𝐌 𝐑𝐄𝐀𝐃𝐘
┃ 📅 𝐂𝐨𝐧𝐧𝐞𝐜𝐭𝐞𝐝: 19 Sept 2026 • 12:51:25 UTC
┃ ✦ 𝐘𝐨𝐮𝐫 𝐀𝐍𝐈𝐌𝐄 𝐌𝐃 𝐬𝐞𝐬𝐬𝐢𝐨𝐧 𝐢𝐬 𝐫𝐞𝐚𝐝𝐲 ✦
╰━━━━━━━━━━━━━━━━━━━━━━━━╯
```
The success block is only claimed when the session is genuinely connected; otherwise the card shows
the real state badge instead.

**SYSTEM STATUS**
```
🟢 𝐁𝐎𝐓: 𝐎𝐍𝐋𝐈𝐍𝐄          🔐 𝐏𝐀𝐈𝐑𝐈𝐍𝐆: 𝐑𝐄𝐀𝐃𝐘
📊 𝐀𝐜𝐭𝐢𝐯𝐞 𝐒𝐞𝐬𝐬𝐢𝐨𝐧𝐬: 2   🔄 𝐐𝐮𝐞𝐮𝐞𝐝: 1   ⏱️ 𝐔𝐩𝐭𝐢𝐦𝐞: 1d 11h 52m
──────── 𝐂𝐎𝐍𝐅𝐈𝐆𝐔𝐑𝐀𝐓𝐈𝐎𝐍 ────────
🌍 𝐏𝐮𝐛𝐥𝐢𝐜 𝐌𝐨𝐝𝐞: 𝐎𝐅𝐅    💎 𝐏𝐫𝐞𝐦𝐢𝐮𝐦 𝐎𝐧𝐥𝐲: 𝐎𝐅𝐅
⚡ 𝐒𝐘𝐒𝐓𝐄𝐌 𝐎𝐏𝐄𝐑𝐀𝐓𝐈𝐎𝐍𝐀𝐋     (⚠️ SYSTEM DEGRADED when a read fails)
```

**ACTIVITY** — design kept, labels bolded, and the number is now rendered *inside* the card from the
event's real number plus the viewer's role:
`👤 𝐔𝐬𝐞𝐫 / 🆔 𝐈𝐃 / 👑 𝐓𝐢𝐞𝐫 / 🔐 𝐌𝐞𝐦𝐛𝐞𝐫𝐬𝐡𝐢𝐩 / ⚡ 𝐀𝐜𝐭𝐢𝐨𝐧 / 📱 𝐍𝐮𝐦𝐛𝐞𝐫 / 🕒 𝐓𝐢𝐦𝐞`.
Seven call sites now pass `number:` instead of a pre-masked string.

**ERROR** — internal faults render `⚠️ Something went wrong on our side. / The problem has been
logged. / Please try again in a moment.`; user-facing errors keep their message (≤200 chars).

## 4. Session logic changes

* `readAllSessions({ fallbackOwnerId })` — awaits the binding, accepts Promise **or** sync array,
  throws `SESSIONS_UNAVAILABLE` on a non-array, and filters stale/invalid entries (no
  `number`/`numberDisplay`) instead of rendering blank rows.
* `sessionStats({ ownerId })` → `{ sessions, queued, sessionError, pairing }`; `null` means
  "could not be read". `pairing === 'ready'` only when the binding exists **and** the read succeeded.
* The list still comes from the one pairing manager (live sessions + credentials re-registered by
  `restore()`); no second session manager, no extra credential scan, storage untouched.
* 0 / 1 / many / reconnecting / disconnected / offline / stale-entry states are all covered by
  `test/telegram-sessions-button.test.js`, plus a genuine read failure.

## 5. Number visibility rules (single decision point)

`displayNumber(session, publicChat, role)`:

| Viewer | Private chat | Group / supergroup |
|---|---|---|
| `OWNER` | full — `+91 987 6543061` | masked — `+91 ••••• 061` |
| `ADMIN` | full | masked |
| `USER` | masked | masked |
| `PUBLIC` | masked | masked |

The default role is `USER`, so an unwired call site fails closed. Callback data still carries only
opaque server-side tokens; button labels follow the same rule; public chats mask for every role;
nothing in the pairing flow, error cards or logs was unmasked. Masking everywhere public is
unchanged (asserted by `telegram-public-group.test.js` and `pairing-acceptance.test.js`).

## 6. Menu / command changes

* `!menu` sends the interactive category picker, a text fallback, then the **complete** registry
  index in chunks of ≤2500 chars (`MENU_INDEX_CHUNK_LIMIT`), whole category blocks kept together so
  nothing is cut mid-category. Every public command appears exactly once, in its real category.
* `!menu` / `!Menu` / `!MENU` resolve through the existing case-insensitive parser (verified live).
* `!menu <category>` (and the numeric reply) opens that category via the existing `helpText()`;
  the numeric path now maps to *visible* (access-filtered) categories only.
* Registry surface: **144 public commands, 272 executable names, 23 categories** — `!aio` added with
  aliases `!allinone` and `!alldownload`, listed once under Downloader, with dispatcher cases for the
  name and both aliases.

**`!aio <link>`** reuses what the project already has: YouTube → `sourceCommands.download`; TikTok,
Facebook, X/Twitter, Instagram, Pinterest, SoundCloud, Mediafire, Google Drive and Terabox route to
their existing specialised handlers. Unknown hosts go through a generic chain
(`dc.aioDownload` → `hdVideoDownload` → `websiteDownload` → `savetubeDownload`) with a final Cobalt
fallback (`requestCobalt` + `downloadRemoteFile`). Media kind is sniffed from magic bytes; video over
60 MiB is sent as a document; exhaustion yields one clean message, never a raw error.

## 7. Tests run and verification result

| Check | Command | Result |
|---|---|---|
| Syntax / lint | `npm run lint` | **85/85 files passed** |
| Full suite | `npm test` (`node --test`) | **640 tests, 638 pass, 1 skipped, 1 fail** |
| Both | `npm run check` | pass (same single failure) |
| Registry validation | `node scripts/command-registry-check.js` | **PASS** — 144 commands, 272 names, 23 complete categories, no duplicates/missing/alias-branch errors |
| Boot | `npm run start:dry` | exits 0 — "Dry run successful. Configuration for ANIME MD is valid." |
| New Sessions-button suite | `node --test test/telegram-sessions-button.test.js` | **12/12 pass** |
| New `!aio` suite | `node --test test/aio-downloader.test.js` | **6/6 pass** |
| Command audit | `node --test test/whatsapp-command-audit.test.js` | **280/280 pass** |

The single failing test is `test/source-replacements.test.js:93` — *"real FFmpeg conversion …"* —
which fails with `FFmpeg is required. Install ffmpeg on the bot host.` `ffmpeg` is genuinely not
installed in this sandbox (`command -v ffmpeg` → not found) and the code path lives in
`system/lib/sticker.js`, which this change never touched. It failed identically on the pre-change
baseline.

**Live flows exercised through the real code** (real `TelegramController`, real dispatcher):

* Sessions button, owner in a private chat → both sessions with full numbers and a real total.
* Same button from a supergroup, still as owner → both numbers masked.
* Normal user `/sessions` → masked rows + management hint.
* Owner system status → real BOT/PAIRING/session/queue/uptime values; with the store down →
  `Unavailable` everywhere and `SYSTEM DEGRADED`.
* Owner/admin panels → real counts healthy, `Unavailable` (not `0`) when a read throws, logged as a warning.
* Connected card → full number for the owner recipient, masked for a normal user, real timestamp.
* Activity card via the same `activityLogger` wiring `index.js` uses → full number for the owner audience.
* Sessions button with a deliberately broken source → the clean internal-error card, zero raw JS.
* Zero sessions → `📭 No paired sessions on this bot.`; `/listpaired` → the all-sessions card.
* `!menu` (interactive and non-interactive) → category picker + full 144-command index in 2 chunks;
  `!MENU Downloader` → the complete downloader help including `!aio <link>  (!allinone, !alldownload)`.
* `!aio` through the real dispatcher (harness network fixtures, as every downloader test in this repo):
  unknown host → generic chain → video delivered; `instagram.com/reel/…` and `fb.watch/…` → routed to
  the specialised handlers → video delivered.

**Not verified here:** real WhatsApp/Telegram delivery and live third-party download endpoints —
this sandbox has no external network and no `ffmpeg`. Everything above ran against the project's own
harnesses and in-memory Telegram client.
