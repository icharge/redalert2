# Auto-submit crash/desync diagnostic reports to the server

## Context

Diagnosing a desync today means asking the user to dig `objectHashes`
JSON blobs out of two browser consoles for a manual diff — the exact
process that found bugs #6/#7/#8 (see `SNAPSHOT_RECONNECT_PLAN.md`).
`Game.getHashBreakdown()`/`Game.getObjectHashList()` already exist for
this, but only ever `console.log()`; nothing leaves the browser.
Separately, the existing "send debug data to Sentry" path
(`GameScreen.ts:1929-1944`'s `debugDataProvider`/`downloadDebugFile`,
backed by `Application.ts`'s `mockSentry` stub) is dead: gated behind a
`debugGameState` config flag that defaults `false`, and even when
enabled, silently no-ops if the shared `workerHostApi` singleton was
disposed elsewhere in the session — confirmed as the actual cause of
the "empty bundle" the user hit. Decision (user-confirmed): stop
chasing Sentry, build our own — and generalize it to **any** in-game
crash, not just desync, since both share the same "something went
wrong, capture what we can and get it off this machine" need. Reports
should be uploaded to the server and persisted per-`gameId`, so
multiple reports from the same match (both desync peers, or a solo
crash) land together for me to inspect without another round of manual
log-pasting.

## Transport: HTTP, not the GservConnection WebSocket

Reversed from an earlier draft of this plan. HTTP wins on three counts:
- No payload-chunking needed — a POST body isn't capped by
  `GservConnection`'s WebSocket ceiling the way a snapshot upload is,
  so the whole `objectHashes` list goes in one request. No new binary
  opcode, no hand-duplicating a wire format across `src/network/
  gservCodes.ts` and `server/src/protocol/gservCodes.ts`.
- Decoupled from the connection that's about to tear down anyway
  (`gservCon.close()` fires right after a desync) — not racing a send
  against a closing socket.
- **Works uniformly across single-player, LAN, and online
  multiplayer** (see below) — `GservConnection` only exists for online
  play (`usesServerConnection() === !isSinglePlayer && !isLanGame`,
  `GameScreen.ts:132`), so a WS-based design would need a completely
  different path for the other two modes anyway. HTTP doesn't.
- Direct precedent already in this codebase: `sendGameRes`/
  `WGameResService` (`GameScreen.ts:1957-1972`, `src/network/
  WGameResService.ts`) already POSTs from this exact `handleGameError`
  desync-trigger point, Bearer-token-authed via the same WOL session,
  with its own retry-within-a-deadline loop
  (`GAME_RES_RETRY_DURATION_MILLIS`, `src/network/gameres/
  wgameResConfig.ts`). New `ErrorReportService` mirrors this file
  almost exactly instead of `sendSnapshotUpload`'s chunking.

## Confirmed: works the same in single-player and multiplayer

`sendGameRes` is already called unconditionally from every relevant
site (`GameScreen.ts:119,1691,1789,1922`) regardless of
`isSinglePlayer`/`isLanGame` — it only no-ops if `wgameresService.
getUrl()` isn't configured (`:1958`). That URL is set during login
(`LoginScreen.ts:622`, `NicknameSelectionScreen.ts:411`), which happens
for every session **including single-player** (this client requires a
WOL login to reach the main menu at all, single-player included). So
the same "configured or silently no-op" pattern already proven for
`wgameres` applies directly to a new error-report endpoint — same
session token, same availability, no special-casing needed for mode.

The one real difference: online multiplayer has a live `gservs`-
registered instance (`GservManager`) the server can cross-check the
`gameId` against; single-player/LAN don't. That's fine — the server
just persists whatever `gameId` it's given either way (see below); it
doesn't need to validate against a live instance to be useful.

Explicitly **out of scope**: `Application.ts`'s top-level `mockSentry`/
`captureException` call sites (`:606,1221,1260,1297`) — pre-game/app-
level crashes with no `gameId`/`game` to attach. Worth revisiting later
as the same pattern, not folded in now.

## Trigger point: `handleError()`, the one true funnel

`handleGameError()` (has `game`) and the generic per-frame crash
handler (`GameAnimationLoop`'s `onError`, `GameScreen.ts:1361` — fires
on *any* uncaught exception during play) currently diverge: the latter
calls `handleError()` directly without a `game` reference at all. But
`handleGameError()` itself already funnels into `handleError()`
(`:1920`), and so does every other error path (map/game load errors,
desync). So `handleError()` is the one convergence point — thread an
optional `game` param through so the animation-loop's `onError` can
pass it along (currently in closure scope at that call site already,
just not threaded through `handleError`'s signature).

## Report payload

`{ gameId, nick, errorType, message, stack, timestamp, clientVersion }`
always; when a live, non-disposed `game` is available, add
`{ tick, hashBreakdown: game.getHashBreakdown(), objectHashes: game.
getObjectHashList() }`. `errorType` distinguishes `'desync_error'` from
a generic crash (map load, UI init, game-loop exception) — the server
only attempts the auto-diff (below) when it sees `objectHashes` on 2+
reports for the same `gameId`.

## Server side

New `POST /errorreport/{sku}` HTTP endpoint in `server/src/http/
routes.ts`, modeled on `handleWgameres()`'s (`:332-444`) request shape
and CORS/response conventions, but with two deliberate departures:

**No mandatory Bearer token.** Single-player/LAN sessions must be able
to submit a report regardless of WOL session state (a crash is exactly
the moment a session might be flaky). Auth becomes *opportunistic*
rather than required: if a valid `Authorization: Bearer` is present,
`deps.sessions.validate(token)` resolves it and the persisted report
is tagged `authenticated: true` with `session.username` as the trusted
nick; if absent or invalid, the report is still accepted, tagged
`authenticated: false`, using the client-self-reported `nick` field
as-is (untrusted, informational only — never used for anything
requiring integrity, unlike `wgameres`'s ladder-scoring path). Also
unlike `wgameres`, does **not** require `deps.gservs.get(gameId)` to
resolve to a known ranked instance — accepts and persists any report
regardless of mode.

**Validity checking, since auth can no longer be the gate.** Two
layers, mirroring existing precedent in this file:
1. *Rate limiting* — a new `errorReport: FixedWindowLimiter` entry in
   `limitersFor()` (`routes.ts:73-92`, same `WeakMap<ServerConfig,
   {...}>`-per-config pattern already used for `login`/`register`),
   keyed by `remoteOf(req)` (the existing IP-extraction helper,
   `:69-71`) rather than by account, since there's no guaranteed
   account here. New `GSERV_ERROR_REPORT_MAX_PER_MIN` config knob.
2. *Schema/sanity validation* — a new `server/src/diagnostics/
   errorReportCodec.ts`, mirroring `gameResCodec.ts`'s `decodeGameRes`/
   `GameResDecodeError` shape: a `validateErrorReport(body: unknown):
   ErrorReport` that throws a typed `ErrorReportValidationError` on any
   failure (caught in the route handler the same way `GameResDecodeError`
   is at `routes.ts:360-364`, → 400 `invalid_report`). Checks: required
   fields present with correct types (`gameId`/`nick`/`errorType`/
   `message`/`timestamp`/`clientVersion` as strings/number, `errorType`
   against a fixed allowlist), reasonable length caps on every string
   field (truncate `message`/`stack` rather than reject — those come
   from `error.message`/`.stack` and can legitimately be long), and — if
   `gameState` is present — `hashBreakdown` has exactly the 9 known
   numeric keys `Game.getHashBreakdown()` produces and `objectHashes` is
   an array of `{id:number,name:string,hash:number}` capped at a sane
   max length (reject a wildly-oversized array rather than truncate,
   since a truncated object list would silently corrupt the diff logic
   below). Raw body size checked against `GSERV_MAX_ERROR_REPORT_BYTES`
   *before* `JSON.parse`, same early-reject-on-size principle as
   `handleSnapshotUpload`'s `maxSnapshotBytes` check.

Correlation state: a small `pendingReports: Map<gameId, {reports: Map<nick, Report>, timer}>` — lives on `GservManager` (already shared
between `WolServer` and `routes.ts`, unlike `GservServer`'s private
per-connection `instanceStates`), not bolted onto the WS relay.

On each report: if `errorType === 'desync_error'`, store it and
reset/arm a short correlation window (`GSERV_DESYNC_REPORT_TIMEOUT_MILLIS`, default 5000ms, same `Number(env.X ?? default)` pattern as
`config.ts:152-164`) — waiting briefly gives the second peer's report a
chance to arrive so the diff below has something to compare against.
Any other `errorType` (a solo crash, single-player or otherwise, with
no second peer to correlate against) is persisted and logged
**immediately**, no artificial wait. When the desync correlation window
elapses:
- If ≥2 reports for the same `gameId` both carry `objectHashes`: diff
  them — log every `hashBreakdown` key that disagrees, and if
  `objectsHash` differs, walk both sorted-by-id `objectHashes` arrays
  in parallel and log the exact `{id, name}` entries that diverge (or
  are present in one but not the other).
- Always persist the full raw report(s) + any computed diff to a JSON
  file under a new `errorReportsDir` config path (mirrors `replaysDir`,
  `config.ts:74,175`): `{errorReportsDir}/{gameId}/{timestamp}-{nick}.json`, so a match's reports (crash or desync, one or both peers)
  collect together in one place regardless of arrival order.
- Log a one-line summary + file path either way (single-report crash
  case included — still useful even with nothing to diff against).

Size cap via a new `GSERV_MAX_ERROR_REPORT_BYTES` (default ~4MB, plenty
for a `getObjectHashList()`-sized payload — the full snapshot loader
benchmarked at ~758 bytes/object; this payload is ~15-40 bytes/object).

## Client-side UI: explicit consent, then a submitting-progress dialog with a timeout-gated Skip

Important correction from an earlier draft of this plan: submission
must not start automatically in the background. The player decides —
this applies uniformly (single-player, LAN, and online multiplayer
alike; called out for single-player/LAN specifically since that's
where "no server relationship at all" makes it most obviously the
player's call, but there's no good reason to treat online differently).

`handleError()` becomes async-aware around two new steps, inserted
before today's `errorHandler.handle(...)` call:

1. If no `game`/`gameId` context exists yet (the earliest map/UI-load
   failures), skip straight to today's behavior — nothing meaningful to
   report yet.
2. **Consent.** `this.messageBoxApi` (the real, full implementation —
   `src/gui/component/MessageBoxApi.tsx`, not `ErrorHandler.ts`'s
   narrower local interface for its own use) already has `confirm
   (message, confirmLabel, cancelLabel): Promise<boolean>` (`:66-71`,
   built on the same `show()` with a `ButtonConfig[]` this file already
   supports) — exactly the two-button primitive needed, no new dialog
   component. Show `TS:SubmitCrashReport` (or similar new string) with
   Submit/Don't-submit labels; only proceed to step 3 if the player
   picks Submit. Declining skips straight to today's unchanged error
   flow, same as the no-context case above.
3. **Submitting-progress with timeout-gated Skip** (unchanged from the
   earlier draft): show a non-dismissable status message via
   `messageBoxApi.show(message)`, reusing the exact pattern already
   used for the "Connecting..." message in `connectToServerInstance()`
   (`GameScreen.ts:690-697`, `setTimeout` + `messageBoxApi.show`), while
   `ErrorReportService.submit(...)` races in the background. Start a
   client-side timer (`ERROR_REPORT_UI_TIMEOUT_MILLIS`, default 8000ms
   — same order of magnitude as `GSERV_SNAPSHOT_REQUEST_TIMEOUT_MILLIS`'s
   existing 8000 default). If the submit hasn't settled by then,
   re-call `messageBoxApi.show(stillSubmittingMessage, strings.
   get('GUI:Skip'), () => resolve('skipped'))`.
4. Whichever settles first (consent declined, upload success, upload
   failure, or the player clicking Skip) proceeds to today's unchanged
   flow: `cleanup()` + `errorHandler.handle(error, message, ...)` +
   `goToScreen`. Upload failure/timeout is silent beyond this — never
   blocks the player from dismissing the actual error, matching
   `sendGameRes`'s existing fire-and-forget-on-failure philosophy
   (`:1969-1971`, just `console.warn`s).

`ErrorReportService.submit()` itself follows `WGameResService.
sendGameResPacket()`'s existing retry-within-a-deadline shape
(`WGameResService.ts:43`, `GAME_RES_RETRY_DURATION_MILLIS`) rather than
a single fetch — reuse that constant or a sibling one scoped to error
reports. It attaches an `Authorization: Bearer` header when a WOL
session token is available (mirrors `WGameResService`'s existing auth
usage) but the request must succeed without one too, matching the
server's opportunistic-auth design above.

**Not implemented in this pass, flagged as a natural follow-up**:
persisting the player's Submit/Don't-submit choice via `LocalPrefs`
(`src/LocalPrefs.ts`'s existing `StorageKey` enum + `getItem`/
`setItem`) so they aren't asked on every single crash. Left out to keep
this change's surface area focused — the plain per-crash confirm
already satisfies "must be able to decide"; remembering the decision is
a UX nicety on top, easy to add later against the same `LocalPrefs`
class already used for similar toggles (`TauntsEnabled`, etc.).

## Files

- `src/network/ErrorReportService.ts` (new) — mirrors `src/network/
  WGameResService.ts`: `setUrl()`, `submit(report)` with retry-within-
  deadline, Bearer-token auth via the existing WOL session.
- `src/game/Game.ts` — no changes; `getHashBreakdown()`/
  `getObjectHashList()` already exist and are reused as-is.
- `src/gui/screen/game/GameScreen.ts` — thread `game` into the
  animation-loop `onError` callback (`:1358-1365`); `handleError()`
  (`:646-669`) gains the async submitting-progress step described
  above; new `buildErrorReport(errorType, error, game?)` helper.
- `src/gui/screen/mainMenu/MainMenuRootScreen.ts` (or wherever
  `WGameResService` is constructed, `:168`) — construct
  `ErrorReportService` alongside it, same `setUrl()` wiring pattern
  (`LoginScreen.ts:622`, `NicknameSelectionScreen.ts:411`).
- `server/src/http/routes.ts` — new `handleErrorReport()`, modeled on
  `handleWgameres()` (`:332-444`); new `errorReport` entry in
  `limitersFor()` (`:73-92`).
- `server/src/diagnostics/errorReportCodec.ts` (new) — `validateErrorReport()`/`ErrorReportValidationError`, mirroring `server/src/ladder/
  gameResCodec.ts`'s `decodeGameRes`/`GameResDecodeError` shape.
- `server/src/gserv/GservManager.ts` — new `pendingReports` correlation
  map + diff/persist logic (or a small sibling module constructed
  alongside `GservManager` if that reads cleaner — decide during
  implementation, keep it out of `GservServer`'s private state either
  way).
- `server/src/config.ts` — `errorReportsDir`, `GSERV_DESYNC_REPORT_TIMEOUT_MILLIS`, `GSERV_MAX_ERROR_REPORT_BYTES`,
  `GSERV_ERROR_REPORT_MAX_PER_MIN`, following the existing `Number(env.X ?? default)` / `path.join(import.meta.dir, ...)` patterns (`:74,152-175`).
- New strings: `TXT_SUBMITTING_REPORT` (or similar) + a `GUI:Skip`
  button label, wherever this client's string table lives (check
  existing `TS:*`/`TXT:*`/`GUI:*` key conventions before adding).

## Verification

1. New server test(s) in `server/test/`, modeled on `gservLifecycle.
   test.ts`'s existing `"desync detection broadcasts..."` pattern:
   POST two reports for the same `gameId` with a deliberately differing
   object hash, assert the server logs/persists the correct diff; a
   timeout-path test with only one report, asserting it still resolves
   (persists what it has) rather than hanging.
2. Manual: trigger a real desync (or force a client-side exception) in
   both single-player and online-multiplayer modes; confirm the
   submitting-progress dialog appears, confirm Skip appears after the
   timeout if the network is blocked, and confirm the existing error
   dialog still ultimately shows either way.
3. Full `bun test` (client + server) stays green; `bunx tsc --noEmit`
   clean on both tsconfigs.
