# Approved scoped update: AutoStatus routing and Telegram titles

## Production changes

### index.js
Removed only the `status@broadcast` exclusion in the two existing message routes:
1. The Telegram-paired session's existing `messages.upsert` callback.
2. The primary session's existing `handleMessages` function.

Both routes still reject missing message content and non-notify upserts. The primary route still checks the active socket. Both call the same existing `system/handler.js` dispatcher. No listener, routing system, handler export, connection logic or authentication behavior was added.

### system/lib/telegram-controller.js
Reused the existing `font` presentation helper for:
- The common boxed title.
- The two existing help-title strings.

Updated the associated rendering comment to describe the requested font. Body text, pairing codes, IDs, URLs, buttons/callback payloads, roles, permissions and controller logic are unchanged. Styling uses mathematical-bold title characters, not a different pairing code or identity configuration.

## Verification

| Check | Result |
| --- | --- |
| Full syntax check | PASS — 71/71 JavaScript files |
| Full automated suite | 273 tests: 272 PASS, 0 FAIL, 1 pre-existing SKIP |
| Existing Telegram targeted suite plus new status-route tests | PASS — 101/101 |
| Pairing acceptance tests | PASS — 7/7 |
| Command/alias/menu audit | PASS — 130 canonical commands, 235 execute names/aliases |
| Duplicate public dispatch cases or aliases | None |
| index.js messages.upsert registrations | Unchanged: 2 before, 2 after (primary and Telegram-paired routes) |
| New Telegram-paired route test listener count | One messages.upsert listener and one existing group-participants.update listener |
| Git whitespace/diff check | PASS |

The new routing tests execute the existing route function/callback extracted from index.js with the **real dispatcher and AutoStatus implementation** and isolated settings stores. Only socket I/O is mocked. They verify viewing and reacting, disabled settings, non-notify exclusion, active-socket gating, missing-content handling, and no duplicate delivery.

Telegram behavior tests now normalize **only boxed title text** for wording assertions. Message bodies and pairing codes remain raw. Separate assertions verify the requested styled headings and unchanged plain body text. No production matching or permission checks were relaxed to make tests pass.

The pre-existing skipped test is the real-supervisor worker-respawn test. Live authenticated WhatsApp/Telegram delivery was not attempted; the results above are automated regression results, not a claim of a live pairing attempt.

## Exact production-scope check

Compared against snapshots taken immediately before this request's edits:
- Replacing only the two old status-filter conditions reproduces the new index.js exactly.
- Reversing the font import and three title-rendering expressions reproduces the old Telegram executable code; only the explanatory comment differs.

No changes in this request to the dispatcher, AutoStatus implementation, commands, aliases, menu, database stores, config, .env, Baileys/dependency versions, Telegram pairing manager/controller store, session code or owner/security checks. Earlier session changes remain as they were.

The previous report's AutoStatus-routing and Telegram-box-title blockers are resolved by this scoped update. Existing command/menu descriptive wording was deliberately not revised because no other production changes were authorized.

## Every file changed in this request

Production (2):
- index.js
- system/lib/telegram-controller.js

Regression tests/support (7):
- test/status-routing.test.js — new real-dispatch routing tests
- test-support/telegram-display.js — test-only boxed-title normalization
- test/pairing-acceptance.test.js — title-format-aware assertions/selectors
- test/telegram-controller.test.js — title-format-aware assertions/selectors
- test/telegram-integration.test.js — title-format-aware assertions/selectors
- test/telegram-public-group.test.js — title-format-aware assertions/selectors
- test/telegram-upgrade.test.js — title-format-aware assertions

Report (1):
- SCOPED-UPDATE-REPORT.md

No package/lockfile changes. Existing npm dependencies and the documented FFmpeg test executable were restored in the sandbox to run the suite.
