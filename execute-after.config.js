'use strict';

// =============================================================================
// EXECUTEAFTER — CENTRAL PROVIDER CONFIGURATION
// =============================================================================
//
// THIS IS THE ONLY FILE YOU NEED TO EDIT.
//
// Everything about the ExecuteAfter framework is driven from here:
//   * how many provider slots exist,
//   * the executable command name of each slot,
//   * the API endpoint, method, headers and auth of each slot,
//   * the API modes each slot really supports,
//   * the response contract (where the fields live in the JSON),
//   * hide / show / enable / disable each command,
//   * HTTP + media safety limits.
//
// You never need to touch the dispatcher, the router, an adapter, the menu or
// any other AnimeMD file to add a provider. Fill the two lines below and it
// runs:
//
//   command:  'Exec1'                 // CHANGE COMMAND NAME HERE
//   endpoint: 'https://...'           // PUT YOUR PERMITTED API ENDPOINT HERE
//
// QUICK START (one provider slot):
//   1. provider_01 → command: 'Exec1'          (or any name you like)
//   2. provider_01 → endpoint: 'https://your-allowed-api.example/search'
//   3. provider_01 → queryParam: 'q'           (the query parameter your API
//                                               documents for search text)
//   4. provider_01 → contract.listPath: 'data.results'   (only if your API
//                                               wraps the list; leave '' and the
//                                               discovery table is used)
//   5. provider_01 → contract.verified: true   (set AFTER you inspected the real
//                                               response of YOUR endpoint)
//
// The framework never invents parameters and never invents JSON fields. If a
// provider is not configured it is reported as UNRESOLVED instead of pretending
// to work.
//
// Full step-by-step guide: EXECUTE-AFTER.md ("MANUAL CONFIGURATION GUIDE").
// =============================================================================

// -----------------------------------------------------------------------------
// PROVIDER REGISTRY
// -----------------------------------------------------------------------------
// One entry = one independent provider slot + one independent adapter
// (system/execute-after/adapters/provider_01.js ...).
//
// The internal identifier of a slot follows its KEY, so a slot, its command and
// its adapter file always stay paired even if you reorder the entries:
//   provider_01: { ... } → slot provider_01 → system/execute-after/adapters/provider_01.js
//   provider_02: { ... } → slot provider_02 → system/execute-after/adapters/provider_02.js
//   provider_03: { ... } → slot provider_03 → system/execute-after/adapters/provider_03.js
//   ...
// A key that is NOT named provider_NN (for example `mySite`) gets the next free
// internal id and a warning is printed once in the console — rename the key to
// that id to keep everything paired. The number of slots always equals the
// number of entries in this object.
//
// Every field is optional except `endpoint` (empty endpoint = slot stays
// UNRESOLVED and replies with a clean "not configured" message).
// -----------------------------------------------------------------------------

const EXECUTE_AFTER_PROVIDERS = {
  provider_01: {
    // =========================================================================
    // CHANGE COMMAND NAME HERE
    // -------------------------------------------------------------------------
    // The executable name. Renaming it here is the ONLY change required:
    //   'Exec1'  →  !Exec1
    //   'myVideoCommand' →  !myVideoCommand   (!exec1 no longer exists)
    // Lowercase and mixed case are the same command: !exec1 = !Exec1 = !EXEC1.
    // Allowed characters: letters and digits, must start with a letter.
    // =========================================================================
    command: 'Exec1',

    // =========================================================================
    // PUT YOUR PERMITTED API ENDPOINT HERE
    // -------------------------------------------------------------------------
    // Full URL of YOUR search API, for example:
    //   'https://api.your-streaming-site.example/v1/search'
    // Query parameters are appended automatically from `queryParam` /
    // `extraParams` / `modeOverrides`. Leave '' while the slot is a placeholder.
    // =========================================================================
    endpoint: '',

    // HTTP verb. GET is normal for search APIs. POST is supported.
    method: 'GET',

    // 'auto'  → the mode is detected from the arguments (recommended).
    // 'search'|'trending'|'latest'|'random'|'info'|'stream'|'download' → always
    // use that mode, ignoring the argument token.
    mode: 'auto',

    // true → the command works. false → the command is not registered at all
    // (it stops existing for the bot, exactly like deleting the slot).
    enabled: true,

    // true → the command still works but is NOT listed in the menu/command list.
    // (Hidden commands stay fully usable, e.g. !Exec1 search naruto.)
    hidden: false,

    // Display name used in the replies instead of the internal id.
    // Example: 'My Site'. Never put a real provider name in command source
    // files; put it here if you want one.
    label: '',

    // =========================================================================
    // API MODES — declare ONLY the modes your API contract really supports.
    // The router rejects everything else with a clean message, so a
    // non-search endpoint is never silently treated as a search endpoint.
    // Recognised values: search, random, trending, latest, info, stream,
    //                    download, auto
    // =========================================================================
    modes: ['search'],

    // =========================================================================
    // REQUEST SHAPING — only what YOUR API documents.
    // -------------------------------------------------------------------------
    // queryParam: the parameter that carries the user's search text ('', 'q',
    //             'query', 's', ...). Empty string on a search mode = the mode is
    //             reported as unavailable instead of guessing a parameter.
    // extraParams: fixed parameters your API always needs (never invent them).
    // pageParam: parameter name for pagination; '' = pagination is not sent.
    // idParam:   parameter name used by info/stream/download modes.
    // =========================================================================
    queryParam: 'q',
    extraParams: {},
    pageParam: '',
    idParam: '',

    // Static headers your API requires (e.g. a public site key). Do NOT commit
    // private tokens here in a public repository.
    headers: {},

    // Optional token auth. type: '' | 'bearer' | 'header' | 'query'.
    // `token` is only read from here when you fill it; nothing is invented.
    auth: {
      type: '',
      header: 'Authorization',
      queryParam: 'apikey',
      token: ''
    },

    // Per-provider timeout. 0 or missing = framework default (see below).
    timeoutMs: 0,

    // =========================================================================
    // RESPONSE CONTRACT — where the data lives in YOUR API's JSON.
    // Leave the strings empty and the documented discovery table is used
    // (works for the common {result:[...]}, {data:{results:[...]}} shapes).
    // Paths are plain dot paths: 'data.results', 'response.videos', ...
    // =========================================================================
    contract: {
      // Path to the array that holds the results.
      listPath: '',
      // Optional: path to a total/result-count value.
      totalPath: '',
      // Optional per-field paths INSIDE one result item. Empty = alias
      // discovery (title|name|video_title|..., see normalize.js).
      fields: {
        id: '',
        title: '',
        description: '',
        thumbnail: '',
        duration: '',
        pageUrl: '',
        streamUrl: '',
        downloadUrl: '',
        embedUrl: '',
        quality: '',
        type: ''
      },
      // Set true AFTER you inspected the real response of your own endpoint.
      // false → the slot is reported as UNVERIFIED (it still tries, but the
      // framework tells you in the logs that the contract was not confirmed).
      verified: false
    },

    // Per-mode overrides. Use this when one endpoint needs different parameters
    // per mode — for example a single API that takes ?list=trending for trends.
    // Example:
    //   modeOverrides: { trending: { extraParams: { list: 'trending' } } }
    modeOverrides: {}
  },

  provider_02: {
    // CHANGE COMMAND NAME HERE
    command: 'Exec2',
    // PUT YOUR PERMITTED API ENDPOINT HERE
    endpoint: '',
    method: 'GET',
    mode: 'auto',
    enabled: true,
    hidden: false,
    label: '',
    modes: ['search'],
    queryParam: 'q',
    extraParams: {},
    pageParam: '',
    idParam: '',
    headers: {},
    auth: { type: '', header: 'Authorization', queryParam: 'apikey', token: '' },
    timeoutMs: 0,
    contract: {
      listPath: '',
      totalPath: '',
      fields: { id: '', title: '', description: '', thumbnail: '', duration: '', pageUrl: '', streamUrl: '', downloadUrl: '', embedUrl: '', quality: '', type: '' },
      verified: false
    },
    modeOverrides: {}
  },

  provider_03: {
    // CHANGE COMMAND NAME HERE
    command: 'Exec3',
    // PUT YOUR PERMITTED API ENDPOINT HERE
    endpoint: '',
    method: 'GET',
    mode: 'auto',
    enabled: true,
    hidden: false,
    label: '',
    modes: ['search'],
    queryParam: 'q',
    extraParams: {},
    pageParam: '',
    idParam: '',
    headers: {},
    auth: { type: '', header: 'Authorization', queryParam: 'apikey', token: '' },
    timeoutMs: 0,
    contract: {
      listPath: '',
      totalPath: '',
      fields: { id: '', title: '', description: '', thumbnail: '', duration: '', pageUrl: '', streamUrl: '', downloadUrl: '', embedUrl: '', quality: '', type: '' },
      verified: false
    },
    modeOverrides: {}
  },

  provider_04: {
    // CHANGE COMMAND NAME HERE
    command: 'Exec4',
    // PUT YOUR PERMITTED API ENDPOINT HERE
    endpoint: '',
    method: 'GET',
    mode: 'auto',
    enabled: true,
    hidden: false,
    label: '',
    modes: ['search'],
    queryParam: 'q',
    extraParams: {},
    pageParam: '',
    idParam: '',
    headers: {},
    auth: { type: '', header: 'Authorization', queryParam: 'apikey', token: '' },
    timeoutMs: 0,
    contract: {
      listPath: '',
      totalPath: '',
      fields: { id: '', title: '', description: '', thumbnail: '', duration: '', pageUrl: '', streamUrl: '', downloadUrl: '', embedUrl: '', quality: '', type: '' },
      verified: false
    },
    modeOverrides: {}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ADD MORE PROVIDER SLOTS HERE
  // Copy the block above and paste it below with the next key:
  //   provider_05: { command: 'Exec5', endpoint: '', ... }
  // The framework creates the slot, the command and an independent adapter
  // automatically — no other file has to change.
  // ───────────────────────────────────────────────────────────────────────────
};

// -----------------------------------------------------------------------------
// FRAMEWORK SETTINGS (safety limits — defaults are production safe)
// -----------------------------------------------------------------------------

const EXECUTE_AFTER_FRAMEWORK = {
  // Master switch. false → the whole category disappears and every
  // ExecuteAfter command stops being registered (AnimeMD is untouched).
  enabled: true,

  // The dedicated menu category. Commands are never mixed into other AnimeMD
  // categories.
  category: {
    id: 'executeafter',
    label: 'EXECUTE AFTER',
    icon: '🎬',
    title: 'Execute After'
  },

  // How many provider commands are listed inside the category menu.
  // Extra slots stay fully usable, they are only hidden from the list so the
  // WhatsApp list/row limits are never exceeded (hard platform limit: 30 rows).
  menuLimit: 10,

  // Maximum number of results rendered per provider answer.
  resultLimit: 8,

  // Anti-spam / anti rate-limit-loop guards.
  perChatCooldownMs: 2500,        // same chat cannot re-run the same provider faster than this
  maxInFlightPerProvider: 1,      // one live request per provider slot (no runaway loops)
  maxInFlightGlobal: 3,           // one live request count for the whole framework

  // Result-shape discovery (documented table only, nothing is invented).
  discovery: {
    enabled: true,
    maxDepth: 4,
    maxArrayScan: 40
  },

  // Optional short-lived metadata cache. Disabled by default: no stale links,
  // no permanent caching, no unbounded memory.
  cache: {
    enabled: false,
    ttlMs: 60000,
    maxEntries: 50
  },

  // Shared HTTP layer (system/execute-after/http-client.js).
  http: {
    timeoutMs: 20000,
    maxAttempts: 3,          // hard ceiling of 5 is enforced in code
    baseDelayMs: 700,
    maxDelayMs: 8000,
    maxResponseBytes: 4 * 1024 * 1024,
    minHostIntervalMs: 250,  // polite pacing per host; avoids 429 loops
    respectRetryAfter: true,
    retryPost: false,
    maxRedirects: 5
  },

  // Stream/download engine (system/execute-after/media-engine.js).
  media: {
    enabled: true,
    maxBytes: 64 * 1024 * 1024,       // never buffer a bigger file than this
    maxConcurrent: 2,                 // bounded concurrency
    queueLimit: 4,                    // extra waiters are refused, never queued forever
    timeoutMs: 120000,
    probeTimeoutMs: 15000,
    maxRedirects: 5,
    // A URL is only accepted as media when the server reports one of these.
    allowedContentTypes: ['video/', 'audio/', 'image/', 'application/octet-stream', 'application/mp4'],
    // A webpage (text/html) or a JSON error envelope is NEVER treated as video.
    deniedContentTypes: ['text/html', 'text/xml', 'application/json', 'application/xhtml+xml'],
    allowedHosts: [],                 // empty = any public host; fill to restrict
    // true only when YOUR OWN media server runs on a private/loopback address.
    // Leave false for public streaming sites (blocks SSRF/private targets).
    allowPrivateHosts: false,
    tempDir: '',                      // empty = <system temp>/anime-md-execute-after
    bufferBelowBytes: 12 * 1024 * 1024, // small files may be sent from memory
    deleteAfterSend: true,            // temp files are always removed afterwards
    streamSettleMs: 2000              // bounded wait for a slow upload before cleanup
  },

  // Safety net for permitted, non-explicit video APIs only. Results whose title
  // or URL matches a blocked term/host are refused. Extend it freely.
  policy: {
    enforce: true,
    blockedTerms: ['porn', 'xxx', 'xnxx', 'xvideos', 'xhamster', 'hentai', 'nsfw', 'adult video', '18+'],
    blockedHostPatterns: []
  },

  // true → extra technical detail in the console (useful while wiring an API).
  verbose: false
};

module.exports = { EXECUTE_AFTER_FRAMEWORK, EXECUTE_AFTER_PROVIDERS };
