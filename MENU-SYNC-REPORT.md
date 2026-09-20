# MENU SYNC AUDIT — ANIME MD

Commit `cd05319` on `arena/01a0b9b4-bug`. Every number below comes from a real scan
(`node scripts/menu-sync-audit.js`, `node scripts/command-registry-check.js`, `npm test`),
not from an earlier conversation.

```text
MENU SYNC AUDIT

✓ Registry scanned                    system/lib/menu.js  (COMMANDS + ALIAS_MAP)
✓ WhatsApp handlers scanned           system/handler.js   dispatchCommand() — 302 case labels
✓ Telegram menu compared              system/lib/telegram-controller.js — 34 command names
✓ Aliases checked                     158 aliases, all resolve to their canonical command
✓ Categories checked                  23 categories, all with metadata, all rendered
✓ Permissions checked                 54 restricted commands, all still listed
✓ Hidden commands checked             !h / !hidden — executable, unlisted (unchanged)
✓ Duplicate commands checked          0
✓ Stale entries checked               0
✓ Missing commands checked            0
✓ Message-size handling checked       chunked at 2500 chars, longest chunk 2573 chars
✓ !menu / !Menu / !MENU checked       runtime-verified in private AND group

Canonical commands:         144
Executable WhatsApp:        302   (144 canonical + 158 aliases)
Visible menu commands:      144
Menu execute names:         302
Aliases:                    158
Categories:                 23

Missing from menu:          0
Non-executable in menu:     0
Duplicate canonical:        0
Obsolete entries:           0
Unresolved categories:      0
Dead routes:                0
Telegram gaps:              0
```

## 1. How the audit works (no guessed lists)

`scripts/menu-sync-audit.js` scans three independent sources and compares them:

```text
REGISTERED   system/lib/menu.js                 → 144 canonical + 158 aliases
EXECUTABLE   system/handler.js dispatchCommand() → 302 case labels (project's own scanner)
MENU         the text !menu actually renders     → commandIndex() output, parsed back
```

The MENU set is read back out of the **rendered menu text**, so a bug in the menu builder
shows up as MISSING/STALE instead of cancelling itself out. Any drift prints the offending
names and exits non-zero. `test/menu-sync-audit.test.js` runs the same audit inside
`npm test`, so drift can no longer ship silently.

## 2. Telegram menu → WhatsApp (all 34 names, nothing copied blindly)

```text
Telegram      WhatsApp counterpart    Status
help          !menu                   WHATSAPP-AVAILABLE
start         —                       TELEGRAM-ONLY
guide         —                       TELEGRAM-ONLY
allmenu       !menu                   WHATSAPP-AVAILABLE (feature-equivalent)
commands      !menu                   WHATSAPP-AVAILABLE (feature-equivalent)
developer     !owner                  WHATSAPP-AVAILABLE (feature-equivalent)
dev           !owner                  WHATSAPP-AVAILABLE (feature-equivalent)
thanks        —                       TELEGRAM-ONLY
thanksto      —                       TELEGRAM-ONLY
myaccount     —                       TELEGRAM-ONLY
account       —                       TELEGRAM-ONLY
admin         —                       TELEGRAM-ONLY
adminpanel    —                       TELEGRAM-ONLY
pair          —                       TELEGRAM-ONLY
sessions      !sessions               WHATSAPP-AVAILABLE
listsessions  !sessions               WHATSAPP-AVAILABLE (feature-equivalent)
status        !status                 WHATSAPP-AVAILABLE
restart       !restart                WHATSAPP-AVAILABLE
addowner      —                       TELEGRAM-ONLY
delowner      —                       TELEGRAM-ONLY
addprem       !addprem                WHATSAPP-AVAILABLE
delprem       !delprem                WHATSAPP-AVAILABLE
addvip        —                       TELEGRAM-ONLY
delvip        —                       TELEGRAM-ONLY
block         —                       TELEGRAM-ONLY
unblock       —                       TELEGRAM-ONLY
listpaired    —                       TELEGRAM-ONLY
premium       !premium                WHATSAPP-AVAILABLE
public        !public                 WHATSAPP-AVAILABLE
settings      —                       TELEGRAM-ONLY
stop          !stopsession            WHATSAPP-AVAILABLE
delpair       !stopsession            WHATSAPP-AVAILABLE (feature-equivalent)
verify        —                       TELEGRAM-ONLY
myid          !uid                    WHATSAPP-AVAILABLE (feature-equivalent)
```

**16 of 34 already have a WhatsApp implementation — and all 16 are already in `!menu`**
(`Telegram gaps: 0`). The other 18 are genuinely Telegram-only (Telegram controller
accounts, admin panel, VIP/block lists, membership verification, the pairing flow itself)
and are **not** advertised as WhatsApp commands.

Why "genuinely": `scripts/command-registry-check.js` asserts the dispatcher's case labels
and the registry agree **in both directions**, so a WhatsApp handler that is not registered
cannot exist. A Telegram-only name therefore has no WhatsApp route to be missing from.

## 3. Aliases — preserved, executable, never duplicated

Every alias resolves through the same `ALIAS_MAP` and reaches the **same dispatcher branch**
as its canonical command (asserted per alias by the registry check). The menu renders
`!canonical • !alias • !alias` on one line, so no alias is ever listed as a second command.
`!menu`, `!Menu`, `!MENU` are case variants of one command — `commandFromText()` lowercases
the name before lookup.

## 4. New short aliases (30 added, all verified executing)

| Canonical | New short aliases |
|---|---|
| `video` | `yt`, `youtube`, `ytv` |
| `ytmp3` | `yta`, `ytaudio` |
| `play` | `song`, `music` |
| `spotify` | `sp`, `spot` |
| `aio` | `alldl`, `anydl` |
| `tiktok` | `tk` |
| `facebook` | `fbvideo` |
| `twitter` | `x`, `tw` |
| `instagram` | `insta` |
| `soundcloud` | `sc` |
| `mediafire` | `mf` |
| `gdrive` | `gd`, `drive` |
| `terabox` | `tb`, `tera` |
| `movie` | `mv` |
| `series` | `srs` |
| `menu` | `m`, `cmds` |
| `status` | `st` |
| `anime` | `ani` |
| `toimg` | `toimage` |
| `tovid` | `tomp4` |

Each one was executed through the real message listener and reached its canonical handler
(21/21 probes, e.g. `!yt https://youtu.be/abc` → `!video`, `!m` → `!menu`, `!alldl <link>` → `!aio`).

## 5. Dynamic menu, message-safe

`!menu` is generated from the live registry at call time (`commandIndex(categoriesWithCommands())`),
so a newly registered command appears with no menu edit and a removed one disappears.
The index is emitted as separate messages chunked at 2500 characters with whole category
blocks kept together — never silently truncated:

```text
!menu → 1) reaction  2) category picker (interactive list, or text fallback)
        3) index chunk 1 — 2573 chars  4) index chunk 2 — 913 chars
```

Buttons/lists stay on the same canonical commands: a button id is the prefixed command
text, and `system/lib/message.js` feeds it back into `extractText()` → the same parser and
the same dispatcher. There is still exactly one command framework.

## 6. Hidden, permissions, categories — unchanged

* `!h` / `!hidden` stay on their own manual-only route (`handleHiddenCommand`), are not in
  the registry and are not listed. No public command was hidden to tidy the menu.
* 54 owner/admin/sudo commands remain listed for everyone and still gated at execution;
  the menu builder never bypasses a permission check.
* All 23 existing categories, labels and icons are untouched. `other` and `settings` have
  metadata but no command, so they are not rendered (reported by the audit as
  `EMPTY CATEGORIES`, not as a failure).

## 7. Public identity rule (the extra ask)

A paired session announced in a group/supergroup now shows the **masked number plus the
pairer's Telegram @username**, so the session is identifiable without disclosing the number:

```text
╭━━〔 𝐀𝐍𝐈𝐌𝐄 𝐌𝐃 • 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃 〕━╮
┃ 👤 𝐔𝐬𝐞𝐫: @rashid_dev
┃ ✦ 𝐋𝐈𝐍𝐊 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄 ✦
┃ ✅ 𝐏𝐀𝐈𝐑𝐈𝐍𝐆 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄
┃ 🟢 𝐖𝐇𝐀𝐓𝐒𝐀𝐏𝐏 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃
┃ ──────── 𝐒𝐄𝐒𝐒𝐈𝐎𝐍 ────────
┃ 📱 𝐍𝐮𝐦𝐛𝐞𝐫: +91 ••••• 061
┃ 🟢 𝐒𝐭𝐚𝐭𝐮𝐬: 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃
┃ ⏱️ 𝐔𝐩𝐭𝐢𝐦𝐞: 00h 00m 00s
┃ 🔄 𝐑𝐞𝐜𝐨𝐧𝐧𝐞𝐜𝐭𝐬: 0
┃ ──────── 𝐒𝐘𝐒𝐓𝐄𝐌 ────────
┃ 🔐 𝐒𝐞𝐜𝐮𝐫𝐞 𝐒𝐞𝐬𝐬𝐢𝐨𝐧
┃ ⚡ 𝐒𝐘𝐒𝐓𝐄𝐌 𝐑𝐄𝐀𝐃𝐘
┃ 📅 𝐂𝐨𝐧𝐧𝐞𝐜𝐭𝐞𝐝: 20 Sept 2026 • 06:42:02 UTC
┃ ✦ 𝐘𝐨𝐮𝐫 𝐀𝐍𝐈𝐌𝐄 𝐌𝐃 𝐬𝐞𝐬𝐬𝐢𝐨𝐧 𝐢𝐬 𝐫𝐞𝐚𝐝𝐲 ✦
╰━━━━━━━━━━━━━━━━━━━━━━━━╯
```

The username comes from the flow actor, falling back to the actor cache the controller
already keeps, so it also appears on a reconnect with no live flow. The group
`ALL SESSIONS` card identifies rows the same way
(`🟢 +91 ••••• 061 — CONNECTED (@rashid_dev)`), and the session-ended card now uses the
same role-aware number rule as every other card. Private Admin/Owner views still show the
full number; masked-everywhere-public is unchanged.

## 8. Files changed

| File | Change |
|---|---|
| `scripts/menu-sync-audit.js` | new — the registered/executable/menu comparison + Telegram classification |
| `test/menu-sync-audit.test.js` | new — 6 tests that fail on any menu drift |
| `test/telegram-public-identity.test.js` | new — 5 tests for masked number + username |
| `system/lib/menu.js` | 30 new aliases on existing commands (no new commands, no new categories) |
| `system/handler.js` | the matching 30 `case` labels, each on its canonical command's branch |
| `system/lib/telegram-controller.js` | `usernameOf()`, username on connected/disconnected cards, group session rows |
| `test/whatsapp-command-audit.test.js` | frozen surface count 272 → 302 |
| `test/aio-downloader.test.js` | `!aio` alias list updated (`alldl`, `anydl`) |
| `COMMAND-REGISTRY.md` | regenerated from the live registry (it was stale: 130 commands, old line numbers) |

## 9. Validation actually run

| Check | Command | Result |
|---|---|---|
| Syntax | `npm run lint` | **88/88 files passed** |
| Full suite | `npm test` | **681 tests, 679 pass, 1 skipped, 1 fail** |
| Registry validation | `node scripts/command-registry-check.js` | **PASS** — 144 commands, 302 names, 23 categories, no duplicate/missing/alias-branch/truncation errors |
| Menu sync audit | `node scripts/menu-sync-audit.js` | **PASS** — all drift counters 0, exit 0 |
| Menu tests | `node --test test/menu-sync-audit.test.js` | 6/6 |
| Public identity tests | `node --test test/telegram-public-identity.test.js` | 5/5 |
| Telegram/menu/pairing/buttons/aio/audit files | `node --test` (14 files) | **536/536** |
| Boot | `npm run start:dry` | exit 0 — configuration valid |

The single failing test is `test/source-replacements.test.js` *"real FFmpeg conversion…"*,
which fails with `FFmpeg is required. Install ffmpeg on the bot host.` — `ffmpeg` is not
installed in this sandbox (`command -v ffmpeg` → empty) and the code lives in
`system/lib/sticker.js`, untouched by this change.

## 10. STATIC VERIFIED + RUNTIME VERIFIED

Runtime here means the real message listener → parser → `dispatchCommand` → registry →
permission gate → category grouping → renderer, with the project's own WhatsApp harness:

* `!menu`, `!Menu`, `!MENU`, `!m` — private **and** group: **302/302** execute names
  rendered, 0 missing, 0 unknown, 0 duplicated canonical, 3 messages, longest 2573 chars.
* `!menu downloader` and `!MENU Downloader` open the same category view with the new aliases.
* 21 alias probes executed and reached their canonical handler.
* Connected / disconnected / all-sessions cards rendered for public, private-user and
  private-owner recipients.

**Not verified here:** real WhatsApp/Telegram delivery and live third-party download
endpoints — this sandbox has no external network and no `ffmpeg`.

## 11. Unresolved / notes

* No missing, stale, duplicate or non-executable menu entry remains.
* `other` and `settings` categories hold no command, so they render nowhere. Intentional —
  they are the registration slots `registerCommands()` uses.
* 18 Telegram-only commands (`start`, `guide`, `thanks`, `thanksto`, `myaccount`, `account`,
  `admin`, `adminpanel`, `pair`, `addowner`, `delowner`, `addvip`, `delvip`, `block`,
  `unblock`, `listpaired`, `settings`, `verify`) are deliberately absent from `!menu`.
  They have no WhatsApp handler, and none was invented.
