# WhatsApp command audit — maintainer report

This is a maintainer audit, **not a public command list**. The public mapping is `COMMAND-REGISTRY.md`; it deliberately omits the manual-only command and its triggers.

## Exact totals

| Item | Count |
|---|---:|
| Public canonical commands | **130** |
| Additional public aliases | **105** |
| Public executable names, including aliases | **235** |
| Menu categories | **23** |
| Hidden canonical commands | **1** |
| Hidden executable names | **2** |
| Total canonical commands, public + hidden | **131** |
| Total normalized executable names, public + hidden | **237** |

Case variants are not counted as additional aliases: command parsing is case-insensitive. Quiz replies such as plain `join`, A–D and 1–4 are contextual input, not additional prefixed commands.

## Davidcaril / davinci identification — private maintainer detail

No standalone `Davidcaril.js`/`davinci*.js` file was found in this checkout. The existing `system/handler.js` contains an explicit `davidcaril.js` comment identifying its manual-only implementation:

- Primary execute name: **`!h`**.
- Alias: **`!hidden`**.
- Case-insensitive examples: `!H`, `!HIDDEN`, `!HiDdEn`.
- Follows the live configured prefix, e.g. `?h` after a prefix change.
- Mapping: `commandFromText()` → `isHiddenCommand()` → `handleHiddenCommand()`.
- Returns the existing **ANIME CORE** card; this is not a separate AI/davinci provider command.
- Public registry, WhatsApp menu categories/list rows, shared public help and generated public command mapping do not expose these triggers.
- The original hidden handler/trigger definitions are byte-for-byte unchanged. Existing public/self-mode checks still apply.

Other modules use a DavidCyril API domain for download/fun commands. A provider hostname is not an execute name and does not make those ordinary registered commands hidden.

## What was scanned and verified

Reviewed the central WhatsApp dispatcher, parser, hidden route, menu/category registry, alias resolver, list/button transport, helper imports, local command functions, source-command adapters, stored media/recovery paths, anime/fun/downloader/quiz modules, quiz data, owner/admin gates, existing tests and command registry audit.

The public mapping file contains a row for **every canonical command**, with all valid aliases, its `!menu <category>` mapping, declared permission, actual awaited handler calls and dispatcher line number. The read-only audit verifies:

1. Registry names and dispatcher cases match in both directions.
2. No duplicate canonical/alias names or duplicate switch labels.
3. Every alias resolves to its declared canonical command and the same switch body.
4. Every entry has a valid category and nonempty implementation route.
5. Every public execute token is rendered in that category's menu.
6. Category lists stay within 30 rows and styled interactive bodies within 3,500 characters, including a four-character prefix.
7. Hidden triggers remain disjoint from public names and rendered lists.
8. Unknown/inherited object-property names do not resolve as commands.

`!menu` remains the existing category browser. Open a category to see all its commands, descriptions, usage and prefixed aliases. Canonical list rows remain executable; aliases are shown in the message body and are manually executable. There is no second registry, loader, listener or dispatcher.

## Findings and minimal fixes

| Finding | Fix |
|---|---|
| Actual WhatsApp category renderer omitted all aliases, even though they were declared in the registry | Reuse the existing shared `helpText(prefix, category)` for both interactive message bodies and text fallbacks; render each alias with the active prefix |
| Interactive row titles could truncate longer usage strings | Keep row titles as canonical execute names; full usage stays in the visible body |
| `anime <title>` menu usage did not match the handler's search subcommand | Show real search/info/download and other supported subcommand forms |
| Quiz menu incorrectly advertised a `maxPlayers` argument | Show the existing category and easy/hard difficulty arguments, plus join/stop |
| `stopsession` description implied local session removal | Describe its actual Telegram-cleanup instruction behavior; do not modify protected session management |
| Alias lookup inherited properties from a normal object | Use a null-prototype lookup map; names such as `constructor` and `__proto__` no longer resolve |
| Explicit quiz joining with no joinable lobby silently returned after a reaction | Return a clear no-lobby message from the existing command branches |
| Quiz advertised plain `join`, but no existing message route forwarded it | Forward contextual plain `join` to the existing quiz join helper, respecting public/self mode |
| Dispatcher forwarded only numbers, while quiz answer parser accepted only letters | Existing route now accepts A–D or 1–4; existing quiz parser normalizes numeric answers to letters; idle numeric menu selection is preserved |

No public command was deleted or hidden to make tests pass. No duplicate, unmapped or alias-to-wrong-branch public command remains in the audited registry. An unused internal `isSudo` helper is not an execute command; it was not removed or used to rewrite protected authorization.

## Execution tests: what they prove

`test/whatsapp-command-audit.test.js` runs **every one of the 235 public execute names** through the actual message parser, real dispatcher and local command handlers in an isolated test harness. It verifies entry to the dispatcher and a non-reaction result or actual socket-operation call, rejects unexpected failure/undefined/NaN output, and checks internal errors.

Fixtures include arguments, media replies, stored-media setup, group metadata and owner context. Privileged actions are exercised with fake socket/process boundaries, not real account mutations. State uses temporary directories; even the legacy dirname-based otaku store is sandboxed without changing its production path.

Additional tests cover:

- All 23 actual category menus in both interactive and text-fallback mode.
- Every alias visible without truncation; canonical button mappings preserved.
- Hidden manual execution across upper/mixed case and a changed prefix.
- Explicit joining with/without an active quiz lobby, no duplicate join response, organizer stop.
- Plain `join`, actual quiz lobby launch, letter/numeric answers, and idle numeric menu navigation.
- Owner-gate denials after making command names visible.

**Test boundaries:** HTTP/provider responses, codecs and restart boundaries are mocked; socket operations are captured rather than sent to WhatsApp. Local command logic and stores run in isolation. Existing regression tests also cover real codec helpers. This proves routing and fixture execution, not live external API uptime, credentials, media delivery or every possible user input.

## Final test results

| Check | Result |
|---|---|
| `node --test test/whatsapp-command-audit.test.js` | **243 tests/subtests passed, 0 failed**; includes all 235 public execute names |
| `npm run check` — syntax | **77/77 JavaScript files passed** |
| `npm run check` — complete regression | **569 tests: 568 passed, 0 failed, 1 existing skip** |
| `node scripts/command-registry-check.js` | **PASS**: 130 public commands, 235 names/aliases, 23 complete categories |
| `git diff --check` | **PASS** |
| Protected baseline hashes | **PASS**, unchanged files listed below |

The existing skip is the supervisor worker-alive/respawn integration test. Final logs: `/home/user/command-execution-final.log` and `/home/user/command-scan-full-final.log`.

## Changed files — this follow-up only

Existing files:

1. `system/handler.js` — category display and minimal quiz input/feedback fixes.
2. `system/lib/menu.js` — prefixed alias display, accurate usages/descriptions, safe lookup map.
3. `system/lib/quiz.js` — numeric-to-letter answer normalization only.
4. `scripts/command-registry-check.js` — expanded read-only mapping/menu audit and mapping report generation.
5. `COMMAND-REGISTRY.md` — regenerated public mapping with handler routes/line numbers, no hidden triggers.

New files:

6. `test-support/command-harness.js` — isolated actual-module execution harness; test-only.
7. `test/whatsapp-command-audit.test.js` — exhaustive execute/menu/hidden/quiz regression tests.
8. `WHATSAPP-COMMAND-AUDIT.md` — this maintainer report.

**No dependencies added or upgraded.**

## Protected systems preserved and remaining limitations

Baseline hashes confirm no changes to `index.js`, security, configuration, session handling, Telegram controller/pairing manager/controller store, otaku database module, JSON store, premium/sudo stores, or package/lock files. No connection listener or bot/socket instance was added. Previous pairing-success/media, status-routing and command integrations remain intact.

No known registry/menu/execute-branch mismatch remains after these fixes and tests. Live provider availability was **not tested** and cannot be guaranteed by static or mocked regression checks. AI, downloads and other external commands still need their documented configuration, permissions, network access and supported media inputs. `stopsession` intentionally gives the existing Telegram cleanup instructions rather than deleting WhatsApp credentials locally.
