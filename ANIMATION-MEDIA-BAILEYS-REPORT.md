# ANIME MD — Animation / Baileys / Media Deep-Scan & Repair Report

Branch: `arena/01a0bdd0-bug`
Checks: `npm run check` → **88/88 syntax files pass · 679 tests pass · 1 fail (pre-existing FFmpeg-missing sandbox env, fails identically on the base commit) · 1 pre-existing skip**
Startup: `npm run smoke` (dry run) PASS · real-module startup used by every e2e script below PASS

---

## DEEP SCAN

**Files inspected (all 88 JS files + configs/tests):**
`index.js`, `system/handler.js`, `system/lib/telegram-controller.js` (4,455 lines — the Telegram dashboard/pairing/verification UI), `system/lib/telegram-pairing-manager.js`, `system/lib/net-tools.js`, `system/lib/session-status.js`, `system/lib/connection-welcome.js`, `system/lib/safe-send.js`, `system/lib/automation.js`, `system/lib/ai.js`, `commands/quiz.js`, `commands/davidcyril-api.js`, `commands/source-commands.js`, `commands/downloader-extended.js`, `commands/temp-mail.js`, `commands/image-generation.js`, `system/lib/telegram-controllers.js`, plus every remaining file scanned for `setTimeout` / `setInterval` / `editMessageText` / `answerCallbackQuery` / reaction patterns.

**Animation systems found (complete map):**
1. **Telegram pairing spinner** (`telegram-controller.js startSpinner`) — 10 braille frames, generation-guarded, per-flow FIFO edit chain. The only true frame-animation in the project.
2. **Telegram verification loading** (`verificationLoadingBox` → success/fail) — one-shot edits, sequentially awaited, correct order.
3. **Telegram menu/navigation** (`present()`) — idempotent edits, "message not modified" handled, falls back to a new message only when the old one is gone.
4. **WhatsApp command reactions** — `⭐` ack on every command, `🔍/⬇️/✅/❌` downloader lifecycle in `source-commands.download`.
5. **WhatsApp `!media`** — was a one-way `⏳ *Downloading…*` TEXT stub (bug; fixed below).
6. **WhatsApp `!ss`** — was a one-way `Capturing screenshot…` TEXT stub (bug; fixed below).
7. **Quiz game** (`commands/quiz.js`) — lobby timer, question timer, between-questions delay, ✅/❌ answer reactions.
8. **Telegram pairing manager** — bounded queue/queue-timeout/reconnect/expiry timers, all cleared; hourly version cache.
9. `bot-tracker`, `safe-send` cleanup intervals — bounded and stopped correctly.

**Baileys connection paths found (all of them):**
- `index.js startBot()` → primary socket (the ONLY `makeWASocket` call site in index.js).
- `telegram-pairing-manager.js openSocket()` → pairing/reconnect sockets for Telegram-paired sessions.
- No other `makeWASocket`, no runtime override of `browser` anywhere.

**Logic mistakes found:** 2 real ones (quiz ghost loop; quiz answer/timeout race) — fixed.
**Performance/reliability issues found:** unbounded body reads (the actual "stuck download" root cause), orphaned stub messages, duplicate concurrent downloads, raw `TypeError: terminated` leaking to users, malformed browser version string.

---

## FIXES

### 1. `system/lib/net-tools.js` — `downloadRemoteFile` / `fetchWithTimeout` / `readLimitedBuffer`
- **Root cause:** `fetchWithTimeout` stopped its clock the moment response HEADERS arrived, so every body read (`response.text()`, stream iteration) was **unbounded**. A stalled CDN/tunnel (headers, then silence) hung the command **forever** — this is exactly why `!media` showed "Downloading…" and never completed, and why `!ss` could hang on a stuck screenshot render.
- **Fix:** `downloadRemoteFile` now owns its AbortController with a **30s re-arming idle deadline** (aborts only when no bytes flow); `fetchWithTimeout`'s deadline now covers the **whole exchange** (headers + body) with a human-readable abort reason; premature close (`TypeError: terminated`) is translated to "The download was cut off before it completed."; failure paths cancel the response body (no socket leak).
- **Why:** every stuck/hanging download now becomes a clean, retryable failure; success still means "fully consumed + content-length verified".

### 2. `system/handler.js` — `!media` (`handleMediaCommand`)
- **Root cause (user-reported):** the flow sent a one-way `⏳ *Downloading…*` text and could never update or remove it; combined with the hang above, the stub stayed in the chat forever.
- **Fix (design unchanged):**
  - Loading **reaction** `⏳` on the invoking message → `✅` on success, `❌` + the existing `*DOWNLOAD FAILED* ❌` error card on failure. No orphaned stub is possible.
  - Media is sent **only after** the download fully completes and validates.
  - `assertMediaBuffer` rejects HTML/JSON error pages served with HTTP 200 ("request successful" is no longer treated as "download complete").
  - Per-URL **in-flight coalescing**: two simultaneous `!media` of the same link run ONE download and both requesters still get their media; the map entry self-deletes on settle (no permanent cache, no stale entries).
  - Success output is byte-for-byte the old design: media + caption + the same interactive card.

### 3. `system/handler.js` — `!ss` (`handleSSCommand`) — the screenshot issue
- **Root cause:** same orphaned-stub pattern, plus the unbounded screenshot fetch could hang forever on a stalled render.
- **Fix:** `📸` loading reaction → `✅`/`❌`; success output (image + `*SCREENSHOT* 📸` caption + `*SCREENSHOT READY* 📸` card) unchanged; capture now hard-bounded (60s total, via fix #1).

### 4. `system/lib/telegram-controller.js` — `startSpinner` cadence
- **Root cause:** the next spinner frame was scheduled **after** the Telegram edit round-trip, so every frame took `800ms + API latency` and frames burst/erred under load (visibly stuttery animation).
- **Fix:** fixed-cadence beats scheduled from tick START; a beat arriving while the previous edit is in flight is **skipped**. Measured: old code gap = **2804ms** (800ms interval + 2s RTT); new = **2401ms** and strictly bounded, ≤ 1 edit in flight, no frame backlog, no burst of edits (Telegram edit rate preserved/reduced). All generation guards, stage updates and stop/restart semantics preserved (verified).

### 5. `commands/quiz.js` — ghost loop + answer/timeout race
- **Bug A (ghost loop):** stopping a quiz while the question-timeout chain was mid-flight let the chain continue and arm NEW question timers — a stopped quiz kept playing forever. **Proven**: the old code sent `QUESTION 2/10` after `!quiz stop`; the new staleness guards (`sendGroupQuestion`, `nextQuestion`, timer callback) abort the chain at the next boundary.
- **Bug B (race):** the question was closed only AFTER the ✅-reaction round-trip, so a timeout firing in that window produced a false "Nobody found the answer" and a duplicated next question. Now the question is closed and its timer cleared **synchronously before the first await**.
- Design, texts and XP logic untouched.

### 6. `index.js` — Baileys browser identity
- `browser: ['Ubuntu', 'Chrome', '20.0.04']` (malformed Ubuntu version, drifting from the other path) → `browser: Browsers.ubuntu('Chrome')` = **`['Ubuntu', 'Chrome', '22.04.4']`** — the exact same descriptor the Telegram pairing path already announces, in Baileys' currently supported Ubuntu Desktop format. **Chrome kept** (it is the client-app name string inside the descriptor; no Chrome installation involved). Verified at runtime; zero overrides exist.

---

## BAILEYS IDENTITY

| | Before | After |
|---|---|---|
| Primary socket (`index.js`) | `['Ubuntu', 'Chrome', '20.0.04']` (Ubuntu, malformed version) | `['Ubuntu', 'Chrome', '22.04.4']` |
| Telegram pairing sockets | `['Ubuntu', 'Chrome', '22.04.4']` (Browsers.ubuntu) | `['Ubuntu', 'Chrome', '22.04.4']` (unchanged) |

**Final identity on ALL connection paths: Ubuntu Desktop + Chrome. No macOS/Windows/unknown path found; no runtime override exists (grep + runtime assertion).**

---

## VALIDATION

| Check | Result |
|---|---|
| `npm run lint` (syntax, 88 files) | PASS |
| `node scripts/command-registry-check.js` | PASS (144 commands, 302 aliases, no duplicates) |
| `node scripts/menu-sync-audit.js` | PASS |
| `npm test` (681 tests) | 679 pass · 1 fail = FFmpeg missing in this sandbox (fails identically on the untouched base commit) · 1 pre-existing skip |
| `npm run smoke` (dry start) | PASS |
| Real stream tests (`downloadRemoteFile` vs local HTTP server) | 6/6: full chunked download · stalled body aborted @30s · truncated body rejected · 404 · zero-byte · oversize limit |
| Real `!media` end-to-end (real handler + real stream download) | ⏳ → full buffer → media + card → ✅ PASS; failure: ⏳ → ❌ + error card, no stuck state PASS |
| Concurrency coalescing | 1 upstream hit for 2 concurrent same-URL requests, both delivered, map cleaned PASS |
| `!ss` end-to-end | success + failure reaction flows PASS |
| Spinner timing | fixed cadence, max 1 in-flight edit, clean stop/restart PASS (old code measured 2804ms gaps vs new 2401ms bounded) |
| Quiz ghost loop | old code FAILS the test (ghost QUESTION 2 after stop), new code PASS |
| Quiz answer/timeout race | timer cancelled at answer time; QUESTION 2 exactly once; no false timeout PASS |
| Baileys identity | runtime assertion: `['Ubuntu','Chrome','22.04.4']` on all paths PASS |

**Lifecycle reasoning (manually walked + machine-verified):**
- start → loading → processing → success: ⭐ → ⏳ → (fully consumed & validated download) → media + card → ✅ — no duplicate sends, no stub left.
- start → loading → error → failure: ⭐ → ⏳ → ❌ + existing error card — no media, no stuck ⏳, no orphan stub.
- start → repeated clicks / cancellation: same-URL requests coalesce; distinct URLs independent; quiz re-clicks are idempotent (`answered` flag, sync close); `!quiz stop` kills armed and in-flight chains; `stopSpinner` leaves zero post-stop frames; restart gets a fresh generation.
- Multi-user isolation: quiz state is per-group; spinner/flows are per-sender in Telegram; the media in-flight map is keyed by URL only (shared download, separate deliveries).

**Remaining warnings:** install FFmpeg on the bot host for animated-sticker conversion (pre-existing, out of scope); sandbox egress is blocked here, so live-provider calls were validated against real local HTTP streams + the project's own mocked harness instead of the public internet.
