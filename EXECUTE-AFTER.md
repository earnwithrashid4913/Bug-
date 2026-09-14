# EXECUTEAFTER — Provider Framework for AnimeMD

**ExecuteAfter** is a self-contained, separately named provider-execution
framework for AnimeMD. It runs your own permitted, non-explicit video APIs as
WhatsApp commands (`!Exec1`, `!Exec2`, …).

It is deliberately built as **one removable block**:

* everything internal lives in `system/execute-after/`
* one central configuration file: `execute-after.config.js`
* AnimeMD itself is touched in exactly **two marked places** (menu bridge +
  handler route), so the whole system can be removed again without leftovers.

| Property | Value |
| --- | --- |
| Framework name | ExecuteAfter |
| Menu category | `EXECUTE AFTER` (id `executeafter`, icon 🎬) |
| Config file | `execute-after.config.js` (repository root) |
| Internal folder | `system/execute-after/` |
| Adapters | `system/execute-after/adapters/provider_NN.js` |
| Default slots | 4 (`provider_01` … `provider_04`) → commands `Exec1` … `Exec4` |
| Second dispatcher / parser | **none** — the existing AnimeMD dispatcher is reused |
| 18+ content | never — policy gate + no adult provider is wired |

---

## 1. Execution pipeline

```
!Exec1 naruto
      ↓
existing AnimeMD dispatcher          system/handler.js  (the ONLY dispatcher)
      ↓
ExecuteAfter router                  system/execute-after/router.js
      ↓
provider configuration               execute-after.config.js → registry.js
      ↓
provider-specific adapter            adapters/provider_01.js
      ↓
HTTP request                         http-client.js (timeout, retries, backoff, 429)
      ↓
response validation                  parser.js + policy.js
      ↓
provider parser                      adapter.parseProviderResponse(data)
      ↓
universal normalization              normalize.js (15 fields, never fabricated)
      ↓
result formatter                     formatter.js
      ↓
existing AnimeMD sender              handler sendResult / lib/ui sendList
      ↓
media engine (stream/download only)  media-engine.js
```

---

## 2. File map

| File | Purpose |
| --- | --- |
| `execute-after.config.js` | **The only file you edit.** Slots, commands, endpoints, modes, contracts, limits. |
| `system/execute-after/index.js` | Façade + `audit()` used by the tests and this report. |
| `system/execute-after/registry.js` | Reads the config, builds slots, registers commands into the existing menu registry, resolves statuses. |
| `system/execute-after/router.js` | The execution pipeline (owns/dispatch), cooldowns, in-flight guard, cache, error isolation. |
| `system/execute-after/context.js` | Command grammar + mode resolution (`search`, `trending`, `info`, …). |
| `system/execute-after/adapters/base-adapter.js` | Shared adapter contract: `async execute(context)`, request building, parsing, counters. |
| `system/execute-after/adapters/provider_01.js …` | One independent adapter per slot. Provider-specific `parseProviderResponse` lives here. |
| `system/execute-after/adapters/index.js` | Cached adapter loader (file adapter, or a generated adapter for extra slots). |
| `system/execute-after/http-client.js` | Shared HTTP layer: timeout, AbortController, bounded retries, exponential backoff, 429/5xx, DNS/empty/invalid JSON. |
| `system/execute-after/parser.js` | Contract-first parsing with a documented discovery fallback; id matching. |
| `system/execute-after/normalize.js` | Universal normalized result (15 fields, missing stays `null`). |
| `system/execute-after/policy.js` | Content policy gate (blocked terms/hosts) for permitted, non-explicit APIs. |
| `system/execute-after/formatter.js` | User-facing cards, lists, buttons, captions. |
| `system/execute-after/errors.js` | Error codes, per-status user messages, technical detail kept in logs only. |
| `system/execute-after/media-engine.js` | Stream/download engine: URL + content-type validation, temp files, cleanup, bounded concurrency. |

AnimeMD touch points (marked in the code):

* `system/lib/menu.js` — bridge block at the bottom: `registry.registerInto(menu)`.
* `system/handler.js` — one route branch: `if (executeAfterRouter.owns(name)) …`.

---

## 3. Command grammar

```
!Exec1                        → first declared list mode (random → trending → latest), else search
!Exec1 naruto                 → automatic mode: search (or info/stream/download if search is not declared)
!Exec1 search naruto          → explicit search
!Exec1 trending               → explicit trending (only if declared)
!Exec1 latest 2               → latest, page 2 (only when `pageParam` is set)
!Exec1 info <id|pageUrl>      → one result, with its links
!Exec1 stream <id|pageUrl>    → downloads and sends the video/audio
!Exec1 download <id|pageUrl>  → downloads and sends the file as a document
!Exec1 modes                  → shows the modes, endpoint and contract status of the slot
!exec1 / !Exec1 / !EXEC1      → the same command (case-insensitive, one registration)
```

Modes a slot may declare: `search`, `random`, `trending`, `latest`, `info`,
`stream`, `download`. `auto` is a configuration value, not a mode.

> The framework never invents a parameter and never guesses that an endpoint is
> a search endpoint: a mode is only usable when **you** declare it in that slot's
> `modes` array. An undeclared mode answers with a clean "not supported" message.

---

## 4. MANUAL CONFIGURATION GUIDE

Everything below happens in **`execute-after.config.js`**. No dispatcher, router,
adapter, handler or menu file ever has to change.

### 4.1 Per-slot checklist

```
provider_01 → command: 'Exec1'  → CHANGE COMMAND NAME HERE
            → endpoint: ''      → PUT YOUR PERMITTED API ENDPOINT HERE
provider_02 → command: 'Exec2'  → CHANGE COMMAND NAME HERE
            → endpoint: ''      → PUT YOUR PERMITTED API ENDPOINT HERE
provider_03 → command: 'Exec3'  → CHANGE COMMAND NAME HERE
            → endpoint: ''      → PUT YOUR PERMITTED API ENDPOINT HERE
provider_04 → command: 'Exec4'  → CHANGE COMMAND NAME HERE
            → endpoint: ''      → PUT YOUR PERMITTED API ENDPOINT HERE
```

### 4.2 Steps for one provider slot

1. **Command name** — `provider_01.command`. Renaming it is the *only* change
   required; the registry, menu, router and adapter all follow automatically.
   Allowed: letters + digits, must start with a letter.
2. **Endpoint** — `provider_01.endpoint`. Paste the full URL of the endpoint you
   are allowed to use. While it stays empty the slot is reported `UNRESOLVED`
   and the command answers "no endpoint yet" instead of pretending to work.
3. **Method** — `GET` (normal for search APIs) or `POST`.
4. **Modes** — declare only what the API really supports, e.g.
   `modes: ['search', 'info', 'stream']`.
5. **Request shaping** — only what your API documents:
   * `queryParam: 'q'` — the parameter that carries the search text;
   * `extraParams: { key: 'value' }` — fixed parameters the API always needs;
   * `pageParam: 'page'` — only if the API paginates;
   * `idParam: 'id'` — the parameter used by `info` / `stream` / `download`;
   * `headers` / `auth` — if the API needs a public key or token;
   * `modeOverrides` — when one endpoint needs different parameters per mode,
     e.g. `modeOverrides: { trending: { extraParams: { list: 'trending' } } }`.
6. **Response contract** — where the data lives in **your** JSON:
   * `contract.listPath: 'data.results'` — path to the results array;
   * `contract.totalPath: 'data.total'` — optional;
   * `contract.fields: { id: 'video_id', streamUrl: 'stream_url', … }` — optional
     per-field paths (leave `''` to use the documented alias discovery table);
   * `contract.verified: true` — set this **only after** you looked at the real
     response of your own endpoint.
7. **Optional flags** — `enabled: false` removes the command completely;
   `hidden: true` keeps it working but removes it from the menu list;
   `label: 'My Site'` changes the name shown in replies;
   `timeoutMs: 15000` overrides the framework timeout for that slot.

### 4.3 Statuses you will see in the console

| Status | Meaning |
| --- | --- |
| `UNRESOLVED` | no endpoint yet (or an unusable command name) → paste the endpoint. |
| `UNVERIFIED` | endpoint set, `contract.verified` still `false` → inspect the real response, then set it to `true`. |
| `READY` | endpoint set and contract verified. |
| `DISABLED` | `enabled: false`, or the framework master switch is off. |

`!Exec1 modes` shows the same information inside WhatsApp (endpoint configured,
contract verified, modes, hidden/listed).

### 4.4 Adding providers 05, 06, …

Copy the `provider_04` block, paste it below and rename the key to `provider_05`.
The slot, the command and an independent adapter are created automatically
(a generated adapter with the same interface is used until you add your own
`adapters/provider_05.js`).

---

## 5. Result shape (universal normalization)

Every provider result is normalized to the same object; **missing data stays
`null` and is never fabricated**:

```
source, sourceName, id, title, description, thumbnail, duration,
pageUrl, streamUrl, downloadUrl, embedUrl, quality, type, metadata, raw
```

---

## 6. Error handling

Each failure is translated into a clean user message; the technical detail
(status, URL, code, stack) only ever reaches the console:

| Situation | What the user sees |
| --- | --- |
| 400 / 401 / 403 / 404 / 408 / 409 / 410 | short, specific sentence (check endpoint, headers, API key, id) |
| 429 | "This provider is rate-limiting requests. Try again in a moment." + `Retry-After` respected |
| 500 / 502 / 503 / 504 | "The provider had an internal error (5xx). Try again later." (bounded retries first) |
| timeout / DNS / network | "The provider did not answer in time." / "The provider address could not be reached." |
| invalid JSON / empty response | "The provider returned no usable data." |
| no results | "No results found." |
| missing/invalid media URL | "The provider did not return a playable media URL." |
| webpage instead of media | "That link is a web page, not a media file." |
| media too large / expired link | clean message, temp file removed |
| content policy | clean refusal, nothing is sent |

**Isolation:** every provider has its own adapter, counters and error boundary.
A failing `provider_02` can never affect `provider_01`, `provider_03`, the media
engine or any other AnimeMD command.

---

## 7. Built-in safety limits (all in `execute-after.config.js`)

* **HTTP** — `timeoutMs` 20 s, `maxAttempts` 3 (hard ceiling 5), exponential
  backoff (`baseDelayMs` → `maxDelayMs`), per-host pacing (`minHostIntervalMs`),
  redirect ceiling 5, response ceiling 4 MB, `Retry-After` respected.
  No infinite retry loop, no infinite polling.
* **Rate limiting / spam** — `perChatCooldownMs` 2500, `maxInFlightPerProvider` 1
  ("This provider is still busy with an earlier request."), `maxInFlightGlobal` 3.
* **Media** — `maxBytes` 64 MB, `maxConcurrent` 2 with `queueLimit` 4, verified
  content types only, no buffering of large files (streamed to a temp file),
  temp files always deleted after sending with a bounded settle wait
  (`streamSettleMs`), stale temp files swept, no permanent caching of video,
  private/loopback hosts refused unless `allowPrivateHosts: true`.
* **Menus** — `menuLimit` 10 rows per category (WhatsApp hard limit 30),
  `resultLimit` 8 results per answer, labels/ids truncated safely.
* **Memory** — bounded maps (cache, cooldowns, host pacing), bounded response
  bodies, bounded discovery depth/array scan, no unbounded listeners or timers.

---

## 8. Tests

New suites (all green):

```bash
node --test test/execute-after-registry.test.js     # 10 tests — registry, slots, commands, duplicates
node --test test/execute-after-pipeline.test.js     # 20 tests — HTTP/parse/normalize/policy/media limits
node --test test/execute-after-media.test.js        # 10 tests — URL/probe/stream/temp-file cleanup
node --test test/execute-after-integration.test.js  #  6 tests — end-to-end through the real handler
```

Existing AnimeMD checks (unchanged behaviour):

```bash
node scripts/syntax-check.js               # PASS 103/103 files
node scripts/command-registry-check.js     # PASS 144 public commands, 265 names/aliases, 24 categories
node --test test/whatsapp-buttons.test.js  # 10/10
node --test test/stability.test.js         # 18/18
```

Pre-existing failures in this sandbox are **not** caused by ExecuteAfter:
`whatsapp-command-audit.test.js` subtests for `alive` / `status` / `runtime` /
`sessions` (a live WhatsApp session is absent, so the bot status is `ERROR`) and
one `telegram-public-group.test.js` case — both already fail on the unmodified
repository.

---

## 9. Removing ExecuteAfter completely

1. Delete `system/execute-after/` and `execute-after.config.js`.
2. Delete the marked bridge block at the bottom of `system/lib/menu.js` and the
   marked route branch in `system/handler.js`.
3. Delete `test/execute-after-*.test.js`, `test-support/execute-after-scenario.js`
   and this document.
4. Optional: `scripts/command-registry-check.js` detects the extension by itself
   and simply reports the smaller numbers again — no change required.

No AnimeMD command, no pairing code, no security check and no other category is
affected in either direction.

---

## 10. Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| `!Exec1` says "no endpoint yet" | paste `endpoint` in `execute-after.config.js`. |
| Command does not exist at all | the slot's `enabled` is `false`, the command name is invalid/duplicated, or the master switch is off (console explains which). |
| "does not support that mode" | add the mode to that slot's `modes` array — only if the API really supports it. |
| "provider returned no usable data" | wrong `contract.listPath` / API shape: inspect the real JSON and set `listPath` + `fields`. |
| "did not return a playable media URL" | the result only has a page link; open it on the provider site, or declare `streamUrl`/`downloadUrl`. |
| "that link is a web page, not a media file" | the API returned an HTML page for a media URL — fix the provider contract, not the engine. |
| "rate-limiting requests" | leave `respectRetryAfter: true`, raise `minHostIntervalMs`, lower `maxInFlightPerProvider`. |
