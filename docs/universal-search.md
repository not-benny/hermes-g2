# Universal search and safe action launcher

The Search glasses app provides one reviewed voice/text query across local sources without sending query or result content to Hermes, a remote ranker, analytics, logs, or durable storage. Apps are the only source enabled when a Search window opens. Every private source must be enabled explicitly from the window menu and those choices remain memory-only for that window.

## Provider contract

`app/search/core.ts` owns the framework-free provider contract and orchestration:

- every provider has a closed source ID, label and privacy class;
- results are inert bounded data with a source-scoped identity, title, snippet, freshness value and optional closed action descriptor;
- malformed batches, unsupported actions and throwing fields fail only their provider;
- ranking normalizes Unicode, matches all query tokens, uses deterministic score/freshness/source/identity ordering and deduplicates exact source identities;
- each query has a monotonic generation and abort signal; a replacement query revokes publication and action authority before asking providers to abort;
- each provider has an independent 1.5 second deadline, so timeout/error/offline/permission states cannot block healthy results;
- action descriptors never reach the UI. The controller replaces them with memory-only one-shot handles bound to the exact query generation and trusted local provider;
- the provider revalidates current permission, source identity and revision immediately before an open. Duplicate taps cannot repeat the action.

There is no query/result/recent persistence. Clear and window close revoke the current generation, pending callbacks and every action handle. Process restart therefore starts with an empty query, Apps-only filters and no reusable capability.

## Current sources

| Source | Privacy | Search scope | Exact open / state |
|---|---|---|---|
| Apps | public metadata | launcher-visible local app titles | Rechecks the local registry, then launches that exact app ID. |
| Calendar | private content | existing bounded upcoming-event read | Reports permission/provider/query failure distinctly; re-reads and matches event ID + start time before showing exact event detail. Search never requests permission. |
| Notifications | private content | existing bounded active notification snapshot | Requires listener access and re-reads the exact Android notification key + observed post time before opening a Search-owned read-only detail. Notification actions, reply and dismissal are not exposed by Search. |
| Files | private content | names/metadata one level below user bookmarks only | Requires the existing all-files grant, exact bookmark root, canonical confinement, non-symlink entry and exact path + modified time before showing metadata. It never recursively indexes storage or reads file content. |
| Media | private content | unavailable | Current queue IDs are not bound strongly enough to an exact media-session incarnation. No play/queue action is exposed. |
| Health | restricted health | unavailable | No bounded consent-scoped summary/search projection exists. Search does not inspect health history. |

Unavailable and permission-denied providers remain visible in the filter menu and status footer rather than silently appearing empty.

## Glasses interaction

1. Open **Search** from the launcher.
2. Long-press and choose **Voice input**. The shell review screen must send the final reviewed text before any provider runs.
3. Long-press to toggle source filters. Apps are on by default; private sources are off.
4. Ring or glasses scroll moves across grouped, source-labelled results and pages. Tap opens the exact selected result. Double-click returns from detail; at the search root it yields to the sidebar.
5. Choose **Clear query** to revoke the query and all handles. Closing the window does the same.

The compact layout is bounded to four selectable rows in the minimum G2 app viewport. Every row displays its source and freshness (static or local date/time) beside the bounded snippet. Snippets are normalized, control/bidirectional characters are removed by adapters, and titles/snippets are capped before entering the core.

## Privacy and safety boundaries

Search never requests Android permissions, executes a URL or shell command, mutates an external service, changes media, reads health history, reads Hermes session projections, sends a cockpit command, or invokes notification actions. File failures use content-free log messages rather than paths or exception bodies. Provider exceptions are converted to coarse source state and are never interpolated into logs or UI. The retired Terminal/G2Mirror surface is neither indexed nor launchable.

The fixture tests contain synthetic data only. Coverage includes Unicode ranking, duplicate identities, empty/disabled filters, pagination, stale non-cooperative providers, provider-timeout abort, permission/offline/unavailable state, malformed throwing/proxy objects, exact-generation one-shot action and in-flight-action revocation, exact notification/file replacement, symbolic bookmark root/entry rejection, clear/restart-like revocation and source-registration/privacy contracts.

## Verification and rollback

Focused host command:

```bash
node --test tests/universal-search*.test.mjs
```

Canonical verification remains `npm test`, `npm run typecheck`, and `npm run build` after NativeScript Android platform preparation. Hardware evidence must distinguish install/launch from real G2 navigation and must not capture private result text. Rollback is confined to `app/search/`, `app/apps/universal-search/`, the Search registry/icon additions, the content-free file-error logging change, tests and this documentation; it requires no data migration because Search persists nothing.
