# Reconnect & Resume Design

Status: Implemented (server + client, v1) — see implementation notes below.
Audience: engineers working on the client (RA2 Web TS port) and the replacement WOL/gserv server.

## Implementation status (v1)

Implemented and tested (server: 208 tests; client: 240 tests incl.
`src/test/rejoinE2E.test.ts` end-to-end reconnect over the real stack):

- Server: loading-phase departure grace (`loadingDepartures` + sweep abort), tickets
  kept valid until instance retire (re-login/rejoin works), mid-game rejoin admission
  (`RPL_RESYNC` + resync log frames + `RPL_NET_RATE`), `ready <turnNo>` command, relay
  hold during the rejoin grace window (`RPL_PLAYER_RECONNECTING/RECONNECTED/GAVE_UP`),
  full per-turn `turnLog` retention, `runSweepPass()` public for deterministic tests.
- Client: `GservConnection` resync buffering + `sendReady`, `LockstepManager`
  `feedActionsPayload`/`getCurrentNetworkTurn`, `GameScreen.runRejoinCatchUp()`
  (fast-replays turns 0..N-2, preloads N-1/N at their canonical ticks, resumes the
  live lockstep at turn N+1 — sim stays tick-aligned with the peers), reconnecting
  player notices + connection-issue dialog suppression, rejoin flow wired into the
  online join path.
- Known limits (v1): the catch-up replay runs at CPU speed (long matches take a while
  on the rejoining client); no LAN rejoin yet; no rejoin time-limit policy for ranked.

## Whole-game pause (MOBA-style, v1)

Implemented alongside reconnect (same relay-hold machinery):

- `pause` / `resume` gserv commands; any member can pause/resume. A 3s server-timed
  countdown runs on both sides (`RPL_GAME_PAUSE_COUNTDOWN/RESUMED`-style broadcasts:
  `809` pause countdown, `810` paused, `811` resume countdown, `812` resumed). Resume
  during the pause countdown cancels it; pause during a resume countdown cancels the
  resume. Per-player pause cooldown (30s).
- While paused the relay holds (`flushPendingTurns` skips) — every client freezes
  naturally and the small accumulated backlog (2-3 turns) flushes on resume.
- Client: "Pause Game"/"Resume Game" button in the in-game menu (MP only), countdown
  overlay + paused dialog with a Resume button, system messages on resume.
- Config: `GSERV_PAUSE_COUNTDOWN_MILLIS` (3000), `GSERV_PAUSE_COOLDOWN_MILLIS` (30000),
  `GSERV_REJOIN_RESUME_COUNTDOWN_MILLIS` (3000), `GSERV_RECONNECT_GRACE_SECONDS` (30).
- Composes with reconnect: a pause during a disconnect hold just rides on top; on
  unpause the relay stays held until the departed player returns or their grace
  expires.

## Reconnect UX (final, per playtest feedback)

- **Disconnect (required player):** server broadcasts `RPL_PLAYER_DISCONNECT` (804,
  "X has left the game") + `RPL_PLAYER_RECONNECTING` (806) to all members; the relay
  holds (game pauses). Clients show the connection-info screen (players + ping) after
  ~2s of stall (original lag behavior) and auto-close it on resume.
- **Rejoin + ready:** after the rejoiner catches up and signals `ready`, the server
  runs a short resume countdown (`GSERV_REJOIN_RESUME_COUNTDOWN_MILLIS`, 3s) holding
  the relay, broadcasting `RPL_GAME_RESUME_COUNTDOWN`/`RESUMED`; clients post
  per-second `[System] Game resuming in 3/2/1...` chat messages plus the overlay, then
  the relay resumes and the connection-info screen closes.
- **Timeout (`GSERV_RECONNECT_GRACE_SECONDS`, 30s):** the departed player's missing
  submissions are backfilled with a `ResignGame` action (units destroyed, marked
  defeated) instead of `NO_ACTION` — in a 2-player game the remaining player wins
  immediately; in 3+ the game continues without them. Clients show "X did not
  reconnect in time and has been defeated."
- **Game already ended while away:** the rejoiner's catch-up detects `Ended` and goes
  straight to the result / score screen instead of entering a frozen game.
- **Game no longer exists:** a failed reconnect re-entry surfaces a clear
  "The game you were in has ended or no longer exists." dialog (reconnect-tagged
  `InstanceNonExistent`).
- **Loading screen** lists the local player first.

## Post-v1 playtest fixes (2026-08-17/18)

Real 2-human + 1-bot playtests surfaced a desync that only ever fired right after a
mid-game reconnect. Root-caused and fixed:

- **Bots and map triggers never activated for a live-joined player.** `Game.status`
  (`src/game/Game.ts`) was declared but never initialized in the constructor, so it was
  `undefined` rather than `GameStatus.NotStarted` (`0`). The live-join guard in
  `GameScreen.ts` (`if (game.status === GameStatus.NotStarted) game.start()`) therefore
  never passed — `game.start()`, and with it `botManager.init()` / `triggers.init()`,
  silently never ran. Both connected clients played the whole match with an inert bot
  (identical broken state on both sides, so desync hashes still matched — nothing
  flagged). The *only* place that ever called `game.start()` unconditionally was
  `runRejoinCatchUp`, so a reconnecting client would be the first to ever actually
  create the bot, mid-match — instantly diverging from the peer that never got one.
  Fixed by initializing `this.status = GameStatus.NotStarted` in the `Game` constructor.
- **A player who went passive (e.g. a backgrounded browser tab) never came back.**
  `GameAnimationLoop` correctly calls `gameTurnMgr.setPassiveMode(true)` when the tab is
  hidden (this is original upstream behavior, not a port bug) — but `GservServer.
  handleActive` only handled the `active: false` half: it removed the nick from
  `requiredNicks` and never re-added it when `active: true` came back in. From that
  point on the player's turns were permanently rejected as stale
  (`ignoring stale turn N from <nick>`, forever) even though their connection never
  dropped. Fixed by mirroring `handleReady`'s re-admission logic for the `active: true`
  case.
- **The desync statedump/lockstep-log export was fully dead**, across four stacked
  bugs, so a repro never actually produced a diagnostic bundle: `debugGameState`
  (`ConsoleVars`) always defaulted to `false` regardless of `config.ini` (`Gui.ts` never
  forced the config value onto the pre-existing `MockConsoleVars` BoxedVar);
  `GameScreen.handleGameError` accepted a `debugDataProvider` callback but never called
  it (upstream hands this to Sentry, which this fork mocks out as a no-op); the export
  closure disposed the single `WorkerHost` shared for the whole app-session lifetime,
  permanently breaking it (and future map loads) after the first desync; and
  `WorkerHost.queueTask` silently discarded task rejections (no-op `resolve`/`reject`
  stubs), so a failing compression step looked identical to success. Separately,
  `compressFile`'s `7z-wasm` init was missing the `locateFile` override
  `GameResImporter.ts` already needed for the same library, so the wasm binary failed
  to load inside the worker. All fixed: a desync now downloads a single
  `desync-debug.7z` (bundled statedump + lockstep log in one file, to avoid browsers'
  multi-download blocker) instead of silently producing nothing.

## 1. Problem statement

Players who leave the game page (refresh, close tab, crash) while an online match is in
progress cannot come back. Today:

- The boot-time "Reconnect to previous game?" prompt is restored client-side, but the
  server rejects every rejoin path, so the prompt can never succeed.
- A disconnect during loading aborts the whole instance for everyone.
- A disconnect mid-game permanently removes the player (NO_ACTION backfill) and their
  turns are gone.

Goal: allow a departed player to rejoin a running match and continue playing, with the
rejoin state verified against the peers (no cheating window).

## 2. How state & sync work today

- Deterministic lockstep: all clients simulate the same game from the same seed and
  apply per-turn action blobs (`LockstepManager`). Turn N advances when every required
  player's submission for turn N has been relayed by the gserv server.
- `GservReplayRecorder` keeps the complete per-turn action log (`events[]`) in memory for
  the whole match and writes it to disk at match end. This is the natural "history"
  source for a rejoiner.
- Desync detection: clients send a state hash every `hashCheckTurnInterval`
  (`LockstepManager` -> `sendGameStateHash`). Hashes are compared; mismatch = fatal
  desync.
- Replays (`ReplayTurnManager`) already deterministically re-simulate a match from the
  action log at arbitrary speed — the catch-up engine exists.

## 3. Why not state snapshots

A raw "send me the current game state" snapshot is impractical: the game has no state
serializer, the object graph is huge (every unit/building/timer/RNG position/AI state),
and any missing detail instantly desyncs. State is already defined as
`initial state + ordered action log` through the deterministic engine, so the resume
format is the action log itself.

## 4. Rejoin modes

| Mode | Memory survives? | Mechanism |
| --- | --- | --- |
| bfcache restore | yes | Page never unloaded. Client only needs to re-establish the network and fetch the turns missed while frozen (server turn retention). No replay. |
| Real reload / close | no | Client restarts its local simulation: fresh boot -> prompt -> re-enter game screen -> load map -> replay full action log from turn 0 at max speed -> hash-verify -> join live. |

Both modes need the same server groundwork (mid-game rejoin admission + turn log
serving). Mode "memory survives" additionally needs server-side retention of recent
turns (a bounded replay window) rather than the full log.

## 5. Current-state audit (what blocks this today)

| Layer | Piece | Status |
| --- | --- | --- |
| Client | Boot prompt (Gui.routeToInitialScreen, LastConnection) | Done |
| Client | GameScreen.onEnter WOL path (connect -> login -> join -> load -> gamestart) | Works |
| Server | Join admission pre-start | Blocked: any disconnect during loading aborts/deletes the instance (GservServer.ts:200-214) |
| Server | Ticket handling | Blocked: ticket consumed on first join (GservServer.ts:374, GservManager.consumeTicketByNick) |
| Server | Join admission post-start | Blocked: RPL_INSTANCE_ALREADY_STARTED (GservServer.ts:357-360) |
| Server | Turn history serving | Not implemented (log exists in GservReplayRecorder.events[]) |
| Server | Relay re-admission | Not implemented (departed nicks removed from requiredNicks + NO_ACTION backfill) |
| Client | Rejoin/catch-up mode | Not implemented (join waits for RPL_GAME_START like a fresh lobby join) |
| Client | Catch-up loading screen | Not implemented (no LoadingScreenType.Reconnect) |
| Client | LockstepManager init at turn N | Not implemented (always starts at 0) |
| Client | Map availability for rejoin | OK — maps are client-local (no mapTransferUrl configured in this deployment) |
| LAN | Mid-game mesh rejoin | Not implemented |

## 6. Design

### 6.1 Phase 0 — make the boot prompt succeed (pre-start rejoin)

1. Loading-phase disconnect: do not abort the instance. Mark the nick `departed` with a
   grace timer (e.g. 90s). loadinfo already reports the player as disconnected; the
   remaining loading screen keeps waiting. If the nick rejoins within the window, resume
   the wait; on expiry, abort/delete the instance as today.
2. Tickets: validate the ticket on login but do not consume it on first join. Keep the
   existing `clearTickets` on game start. This lets a departed player rejoin with their
   own nick while loading.

### 6.2 Phase 1 — server: mid-game rejoin + resync protocol

3. `handleJoin`: admit roster nicks to a started instance. Respond
   `RPL_RESYNC <turnCount>` instead of `RPL_INSTANCE_ALREADY_STARTED`. Unknown nicks
   continue to be rejected.
4. Serve the retained turn log: serialize `GservReplayRecorder.events[]` (same format as
   the replay file writer) and send it in bounded chunks after `RPL_RESYNC`.
5. Rejoining state: the rejoined nick is excluded from `requiredNicks` and turn relay
   until it sends `ready <turnNo>`; on ready, re-add it to `requiredNicks` for the
   current pending turn.
6. Departures mid-game: hold the relay (see 6.6) for a grace window; backfill
   `NO_ACTION` + remove from `requiredNicks` only on window expiry (current behavior).

### 6.3 Reconnect pause (v1)

The match pauses while a departed player reconnects, so the rejoiner loses nothing and
everyone resumes together from the same turn.

**Mechanism.** When a roster nick disconnects mid-game, the server does NOT backfill
their submissions and does NOT remove them from `requiredNicks`. The relay naturally
holds: `flushPendingTurns` waits for the absent nick, clients stall on
`canAdvanceNetworkTurn()`, and the game freezes for everyone — the same mechanism that
today causes the accidental freeze, but now deliberate and bounded.

**Grace window.** The hold lasts `RECONNECT_GRACE_MILLIS` (e.g. 30–45 s, enough for a
reload + boot + map load + catch-up). On expiry: backfill `NO_ACTION`, remove the nick
from `requiredNicks`, flush pending turns — the game continues as today.

**Client UX during the hold.** The connection-issue dialog (`CON_INFO_THRESH_MILLIS`
lag timer in GameScreen/LockstepManager) must be suppressed while the departed player
is in a rejoin window, and replaced with a "X is reconnecting" notice (reuse the
existing player-status / connection-info plumbing).

**Rejoin during the hold.** The rejoiner reloads, replays the log to the hold point
(turn N), hash-verifies, sends `ready N`; the server resumes the relay at N and
everyone continues from exactly where the match paused. If the game was in a hold, the
rejoiner never misses a turn.

**bfcache-restore mode does not need the pause** — restore is near-instant and the
missed window is small.

**Alternative (no pause).** The match keeps running (immediate `NO_ACTION` backfill);
the rejoiner fast-forwards to the live tick and takes over whatever survived. Simpler
and nobody waits, but the returning player's units idle while away and can be destroyed
before they come back. V1 chooses the pause; the no-pause variant is a fallback if the
hold UX proves disruptive.

### 6.4 Phase 2 — client: rejoin flow

7. `GameScreen` detects a rejoin (RPL_RESYNC) and enters a new loading phase
   (`LoadingScreenType.Reconnect`) showing "Synchronizing... replaying turn X/N".
8. `GservConnection` gains a resync request/response path; the received log feeds a
   fast-forward loop built on `ReplayTurnManager`/`processActions` (max speed, progress
   reporting).
9. Verification seam: at catch-up end, the rejoiner computes `game.getHash()` at the
   join tick; the server/peers compare it against the hashes recorded at that tick.
   Mismatch -> desync -> kick. This closes the cheating window (a rejoiner cannot skip
   or alter history without failing the hash).
10. `LockstepManager` supports initial turn N (start `currentNetworkTurn` and
    `receivedNetworkTurn` at N+1, subscribe from there), then the client sends
    `ready` and plays live.

### 6.5 Phase 3 — LAN (later)

The control peer retains the turn log and admits a returning peer mid-game; the same
catch-up UI and hash-verification apply, over the mesh channel.

### 6.6 Phase 4 — policy & polish

- Rejoin window (e.g. rejoin allowed while the match is < N minutes old, or unlimited
  for unranked, capped for ranked).
- Rejoin rate limiting per nick.
- `GservReplayRecorder` keeps capturing the rejoined player's actions.
- Consider a "player rejoining" indicator on other clients (connection-info screen /
  lag state), reusing the existing player-status plumbing.

## 7. Protocol changes (summary)

- gserv: `join` on a started instance -> `RPL_RESYNC <turnCount>` (was
  RPL_INSTANCE_ALREADY_STARTED) for roster nicks.
- gserv: resync payload lines (chunked turn log, replay-file serialization).
- gserv: `ready <turnNo>` from the rejoining client -> re-add to requiredNicks.
- Client: `GservConnection` resync sender/parser; `LockstepManager` initial-turn
  support; reconnect loading screen.

## 8. Open questions

- Ranked policy: allow rejoin in ranked matches? For how long?
- Should a rejoined player's absent period be recorded as a quit on the score report?
- Turn retention window if we later want bfcache-restore to only replay the missed
  window instead of the full match.
- LAN scope/priority.
- Rejoin UX for the hold: exact grace window value, and whether a reconnecting notice
  needs a sound/announcement like `EVA_UnitLost`.
- Interaction between the hold and `checkGameEndConditions` (a hold must not let a
  victory/defeat fire for a side that still has a reconnecting player).

## 9. Out of scope

- True state snapshots / mid-game save-anywhere.
- Rejoin after the match has ended (score screen already handles that path).
- Cross-device resume (the rejoiner must be the same account/nick with the same map
  resources).
