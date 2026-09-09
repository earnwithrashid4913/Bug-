# ANIME MD — Deep-Scan & Repair Report

Branch: `arena/01a082fb-bug` · Commits `5e02d64`, `6acb566`
Checks: `npm run check` → **47/47 syntax files pass · 157 tests pass · 0 fail · 1 pre-existing skip**
Startup verified: `npm run smoke` (dry run) and `node index.js` (real start → clean idle → SIGTERM exit 0)

---

## PAIRING

### Root cause (proven, not guessed)

`config.js` shipped `telegram.pairingCode: 'GOATMODS'`. That value was normalized to
`GOATMODS` (8 chars, so it passed the length check) and forwarded to
Baileys' `requestPairingCode(number, customPairingCode)`.

In the installed Baileys (`node_modules/@whiskeysockets/baileys/lib/Socket/socket.js:596`):

```js
const requestPairingCode = async (phoneNumber, customPairingCode) => {
    const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5));
    ...
    authState.creds.pairingCode = pairingCode;
```

So the literal string `GOATMODS` became the pairing code, and the pairing key is
PBKDF2-derived from it (`derivePairingCodeKey`, `lib/Utils/crypto.js:98`).

WhatsApp generates its own codes with `bytesToCrockford(randomBytes(5))` over the
32-symbol alphabet:

```
123456789ABCDEFGHJKLMNPQRSTVWXYZ      (no 0, no I, no O, no U)
```

Verified against the shipped Baileys source:

| char | in alphabet |
|---|---|
| G, A, T, M, D, S | valid |
| **O** (×2) | **NOT in alphabet** |

`GOATMODS` contains two `O` characters. WhatsApp's "Link with phone number" input maps
each typed character to a position in that alphabet to rebuild the code and re-derive the
key; `O` has no position, so the code could be displayed but never entered or linked.
Real WhatsApp codes are always 8 characters drawn from that alphabet.

### Exact fix

- `config.js` — `telegram.pairingCode` **removed** entirely, with a comment explaining why.
- `system/config.js` — `normalizeCustomPairingCode()` and `telegramPairingCode` removed
  from the frozen runtime config.
- `system/lib/telegram-pairing-manager.js` — the custom-code plumbing (`customPairingCode`
  constructor arg, `normalizeCustomPairingCode`, `custom` result flag, GOAT branding)
  removed. The single production call site is now:

  ```js
  const code = await session.socket.requestPairingCode(number);   // phone number only
  if (!code || typeof code !== 'string') throw pairingError('WhatsApp did not return a pairing code.', 'PAIRING_FAILED', 502);
  ```

  The returned value is passed through verbatim as `code`, and formatted as `XXXX-XXXX`
  only for display (`displayCode`).
- `system/lib/telegram-controller.js` — `GOAT_MODS_BRAND` removed; the box title is now
  `ANIME MD • PAIRING CODE`; the long Roman Urdu paragraph trimmed to one line.
- `index.js` — `customPairingCode` no longer passed; `codeSource` (display metadata only).

### Confirmation

- **Real Baileys code is used.** `grep` shows exactly one production call site, with one
  argument. `test/pairing-acceptance.test.js` asserts the Telegram-displayed code equals
  the socket's returned code, that only one argument is passed, and that every character
  of the code is in WhatsApp's pairing alphabet.
- **Fake/custom GOAT-MODS flow removed.** `grep -rn "GOAT"` over source returns only
  comments/tests that document the removed defect. `GOAT_MODS_BRAND`,
  `normalizeCustomPairingCode`, `customPairingCode`, `telegramPairingCode`, `pairingBrand`
  and `brandLabel`-as-custom-code are all gone from the runtime path.
- **No fake connection state.** `connection.update === 'open'` is still the only trigger
  for `notifySessionConnected`; the acceptance test asserts "WhatsApp Connected" is absent
  before the replacement socket reports open.

### Session safety (unchanged, verified by existing tests)

Per-number auth dir `<authDir>/telegram-pairings/<telegramId>/<number>`, per-number locks,
no duplicate sockets, credentials deleted only on terminal disconnects, `restartRequired`
(515) after linking latches `registered` and reconnects instead of destroying the session.

---

## BUTTONS

| Metric | Value |
|---|---|
| Button ids traced end-to-end | **738** (178 quick-reply + 480 setting/toggle + 80 list rows) |
| Commands whose live reply carries buttons | **78 / 80** (was 22 / 80, same harness) |
| Broken buttons found | 4 classes |
| Broken buttons fixed | 4 classes |
| Dead buttons left | 0 |

**Broken → fixed**

1. `!convert` fired `!sticker` / `!toimg` / `!tts` with no argument → each just echoed a
   usage line. Replaced with real navigation.
2. `!tools` fired `!calc` / `!short` / `!translate` with no argument → same. Replaced.
3. `!group` fired `!tagall` with no argument → usage line. Replaced with `!menu anti`.
4. Media replies duplicated the button-card text verbatim (two messages, same text).
   Media now carries a short caption; the card carries the detail lines.

Also caught and fixed during development: `safeCommandId` initially emitted `! video Faded`
(space after the prefix), which would have made **every** button unparseable. Detected by a
smoke check before shipping.

**Intentional exceptions:** `hidetag` (a following card would defeat its purpose of being
invisible) and `tagall` (the message already lists every member). Both still get a
navigation card on their usage/error paths.

**Compatibility rules enforced** (`system/lib/whatsapp-actions.js` + `system/lib/ui.js`):

- ≤ 3 quick replies per message — the count that renders on both WhatsApp and WhatsApp
  Business; richer navigation goes through `single_select`.
- Every id built from the **live** prefix → buttons survive `!setprefix` and reconnects
  (asserted by test).
- Ids ≤ 200 chars, no control characters, no duplicate ids per row.
- Every id parses through the real `commandFromText()` and resolves to a registered command.
- `single_select` sections capped at 30 rows.

**Button test matrix** (`test/whatsapp-buttons.test.js`, 10 tests): structural audit of all
738 ids, list-row audit, prefix-change survival, paramsJson sanitization, toggle semantics,
navigation helpers, **real click simulation** through `interactiveResponseMessage` /
`nativeFlowResponseMessage.paramsJson` (the payload both clients send), second-click
repeatability, argument-less button guidance, and legacy payload shapes
(`buttonsResponseMessage`, `listResponseMessage`, `templateButtonReplyMessage`).

---

## COMMANDS

- **80 commands scanned** (140 recognized names incl. aliases), 20 categories.
- Every registered command has a handler — verified by dispatching all 80 through the real
  `handleMessage()` (`test/command-regression.test.js`): recognized, never throws, always
  replies, no `undefined`/`NaN`/`[object Object]` leakage.
- Repeated with an unexpected free-text argument: 0 failures.
- Permission gates verified: admin commands refuse outside a group, owner commands refuse
  for normal users.

**Bugs found and fixed**

| Bug | Fix |
|---|---|
| `!getpp <bad number>` threw out of the handler → user got **no reply at all** | Validation caught, short error returned |
| `!mode` declared `permission: 'owner'` but the bare `!mode` view had no owner gate | Owner gate enforced at dispatch |
| `!broadcast` replied "Broadcast sent." while sending **nothing** | Real delivery via a tracked chat registry (`system/lib/chats.js`); reports actual delivered/failed counts |
| Any handler error produced silence | Guarded dispatch: user gets `*COMMAND FAILED*`, error is logged, then **re-thrown** so the transport contract is preserved |
| 17 guidance/permission prompts were dead ends | Now carry a real button row |
| `sendButtons` could emit a zero-button interactive message | Falls back to a Menu button |

---

## APIs

| Provider | Used by | Key | Status |
|---|---|---|---|
| Cobalt `cobalt-api.kwiatekmiki.com` | `play` `ytmp3` `video` `media` | none | third-party, **not reachable from this sandbox — unverified live** |
| Groq | `ai` | `api.groqApiKey` | placeholder `YOUR_GROQ_API_KEY`; `!ai` correctly says "AI is not configured" until set |
| YouTube `results` HTML scrape | `play` `video` search | none | inherently fragile; errors handled |
| Spotify web-player token | `spotify` | none (public endpoint) | fragile; album art was requested but never returned — **fixed** |
| `translate.googleapis.com` | `translate` `tts` | none | errors handled |
| `image.thum.io` | `ss` | none | errors handled |
| `tinyurl.com/api-create.php` | `short` | none | errors handled |
| Catbox | `tourl` | none | errors handled |

- **No API key is committed.** `config.js` holds only `YOUR_...` placeholders.
- No key appears in any Telegram message, WhatsApp message, log line or error string.
- No provider was replaced.

**Media reliability:** `downloadRemoteFile` now rejects zero-byte bodies and bodies shorter
than `content-length`, so a truncated file can never be sent to WhatsApp. All downloads use
in-memory buffers handed straight to Baileys — no temp files, so no temp-file leak and no
"deleted before WhatsApp consumed it" window.

---

## ERRORS

- **Syntax:** 47/47 files pass `node --check`. No `Unexpected token`, no malformed regex.
- **Runtime:** real `node index.js` start → clean idle → SIGTERM → exit 0. Dry run clean.
- **Integration:** 157 tests pass, 0 fail. The 1 skip is pre-existing
  (`test.skip('the real supervisor keeps a worker process alive and respawns it')`).
- **Fixed:** `!getpp` throw, `!mode` permission mismatch, `!broadcast` fake success,
  silent handler failures, duplicated media captions, Spotify album art, zero-byte downloads,
  2 genuinely unused imports (`cleanText`, `resolveCommand` in handler.js).
- Duplicate listeners audited: primary socket registers each event once (`index.js` 440-449);
  Telegram-paired sockets once via `onSocket` (180/187); pairing manager adds its own
  `creds.update`/`connection.update` per session socket. No duplicates, no double
  `messages.upsert`.

---

## BAILEYS

- **Current version preserved:** `@whiskeysockets/baileys` **7.0.0-rc14** — asserted by test
  (`test/pairing-acceptance.test.js`).
- **No upgrade, no downgrade, no library replacement.** `package.json` dependency block is
  untouched; `npm ci` installed exactly the locked versions (110 packages, 0 vulnerabilities).
- **Socket/auth architecture preserved:** `useMultiFileAuthState` +
  `makeCacheableSignalKeyStore`, `browser: ['ANIME MD','Chrome','1.0.0']`, per-session
  auth dirs, QR-gated pairing readiness, `restartRequired` latch, reconnect backoff, stale
  sweeps — all unchanged.
- No unrelated dependency was touched.

---

## FINAL STATUS

**READY FOR DEPLOYMENT ✅** for everything verifiable in this environment.

Two things cannot be verified here and should be confirmed once on a live deployment:

1. **Physical client rendering.** There is no WhatsApp/WhatsApp Business device or WhatsApp
   network access in this sandbox, so button rendering and tap-delivery were verified
   structurally (payload shape, proto round-trip through real Baileys `generateWAMessageFromContent`,
   and click simulation using the exact payload both clients send) — **not** on a real phone.
2. **Live providers.** Cobalt / YouTube / Spotify / Groq were exercised only through their
   error paths (network stubbed), so real download success is unverified here.

Recommended first live checks: `/pair <number>` → confirm the code shown is 8 characters
from `123456789ABCDEFGHJKLMNPQRSTVWXYZ` and links on the first try; then `!menu` → one
category → one downloader command → tap a button.
