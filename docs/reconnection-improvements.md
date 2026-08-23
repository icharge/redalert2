# Reconnection Improvements: Pause UX, Rejoin Progress, and Kick/Wait Voting

Status: **implemented** (all three phases, server + client, with regression and mutation-tested
unit/E2E coverage — see §8 for the checklist)

Audience: engineers working on the gserv match server and the in-game connection UI.
Builds on [`reconnect-resume.md`](reconnect-resume.md), which documents the shipped v1
reconnect flow. A possible future extension is documented separately in
[`ai-takeover-on-disconnect.md`](ai-takeover-on-disconnect.md).

## 1. Motivation

When a required player drops mid-game the relay already holds turns correctly — via
`hasAbsentRequiredPlayers()` and `flushPendingTurns()` in `server/src/gserv/GservServer.ts` —
and after `reconnectGraceSeconds` (default 30) `expireDeparted()` injects a synthetic
`ActionType.ResignGame` blob so the game can continue. Functionally correct, but three UX
problems remain:

1. **The pause is invisible for ~3 seconds.** The connection-info screen only opens off a
   *client-local lag heuristic* (`LockstepManager.onLagStateChange`, 1s stall threshold, plus a
   2s `CON_INFO_THRESH_MILLIS` debounce) — even though the server broadcasts
   `RPL_PLAYER_DISCONNECT` / `RPL_PLAYER_RECONNECTING` the instant the socket closes, and
   `GservConnection` already turns those into events that nothing subscribes to for this purpose.

2. **Waiting players cannot see how far along a rejoiner is.** Since snapshot-based reconnect was
   abandoned in favour of full replay from turn 0, a rejoiner re-simulates the entire match — a
   real wait on a long game. `runRejoinCatchUp()` already computes a catch-up percentage for its
   own loading screen but never shares it with anyone else.

3. **The grace window is a fixed, take-it-or-leave-it timer.** With 3+ players there is no way to
   collectively say "she's coming back, give her another 30s" or "he's gone, let's move on."

## 2. Product rules

- **Two vote choices only: kick and wait.** No separate "resume" option — in deterministic
  lockstep the simulation cannot advance past a missing required player's turn slot, so
  "resume without them" is by definition identical to resigning them.
- **A wait vote vetoes a kick, but via a bounded extension pool** — N extensions (default 2)
  worth M seconds each (default 30s). Once the pool is exhausted, wait votes become advisory
  only and no longer block a kick. This stops one player stalling a match indefinitely.
- **Kick passes on simple majority** (>50%) of eligible voters: connected, required,
  non-observer humans, excluding the departed target.
- **Voting availability is decided by the live count at drop time** (`requiredNicks.size >= 3`),
  not the original lobby size. An attrition-reduced 2-player situation correctly gets no vote,
  rather than letting a lone remaining player unilaterally decide another's fate.
- **A cast vote is final.** Once you have voted you cannot change or withdraw it; the UI
  replaces the buttons with the standing count, and `handleVote` refuses a second vote from the
  same nick so a modified client cannot flip either. See §14 for why finality forced the
  extension rule below to change.
- **Each player voting wait buys one extension.** Charged per distinct wait voter, at most once
  each, so total purchasable time is hard-capped at `extensionsMax × extensionSeconds` however
  many players vote wait.
- **The vote itself does not open the instant someone drops.** The connection-info screen can
  already appear off a much shorter signal (the client-local lag heuristic fires around a ~1s
  stall, and the screen opens immediately once the server confirms a genuine drop — see §4).
  Most drops are a brief network blip that resolves itself within a few seconds; nobody should
  be asked to weigh in on kicking a player who is about to reconnect on their own. The vote
  becomes available only after a separate, longer delay (default 10s) has passed with the
  player still away — a reconnect within that window cancels it outright, and no vote is ever
  offered for that drop.
- **2-player games get no voting UI at all** — their existing grace-timer behaviour is unchanged.

## 3. Phase 1 — Rejoiner progress bar

Reuses the existing `loaded` wire message rather than adding a protocol message.
**Verified safe:** `checkAllLoaded()` returns immediately when `instance.started` is true
(`GservServer.ts:559-560`), so a mid-game `loaded <pct>` merely updates `client.loaded` and
re-broadcasts load info — no side effects.

| File | Change |
|---|---|
| `src/network/gamestate/PlayerConnectionStatus.ts` | Add `Rejoining = 4` |
| `server/src/gserv/GservServer.ts` (`sendLoadInfo`, ~974-986) | `const status = !member ? 0 : state?.rejoiningNicks.has(nick) ? 4 : 1;` |
| `src/gui/screen/game/GameScreen.ts` (`runRejoinCatchUp`, ~1602-1643) | In the existing `updateProgress()` closure, add `this.gservCon.sendLoadedPercent(percent)` |
| `src/gui/screen/game/gameMenu/ConInfoForm.tsx` | Add `loadPercent?: number` to the local `ConInfo` interface; render `<progress>` in the `player-time` cell when status is `Rejoining` |

**Do not repurpose `Lagging`** for this. It already means "connected but slow" where it is used
(`DiploForm.tsx`) — a different condition from "socket open, deliberately suppressing live play
while replaying turns 0..N." Reusing it would give one enum value two unrelated meanings.
Nothing switches exhaustively over this enum (both consumers only compare `=== Connected`), so a
new value is purely additive.

`LoadInfoParser` already parses `loadPercent` (`src/network/gameopt/LoadInfoParser.ts:17`) — it is
simply never threaded into the React component today.

The ~50ms chunk cadence of the catch-up loop is well within the 600-capacity / 200-per-second
rate bucket (`GservServer.ts:41-42`). The reported value naturally returns to 100 once caught up.

**Backward compatible:** an older client seeing an unfamiliar `status=4` falls into its existing
`!== Connected` reconnect-badge branch — degraded, not broken.

## 4. Phase 2 — Deterministic pause UX

Client-only; no protocol or server change. In `GameScreen.ts`'s `disconnectHandler` (~362-391),
which currently only posts a chat notice, also open the connection screen immediately:

```ts
const disconnectHandler = (nick: string) => {
    playerNoticeHandler(nick, 'ts:player_disconnected');
    if (nick !== playerName && !(this.menu?.getCurrentScreen() instanceof ConnectionInfoScreen)) {
        this.menu?.openConnectionInfo(game.getCombatants(), this.gservCon, this.chatNetHandler);
    }
};
```

The `instanceof` guard matters: `Controller.goToScreen` tears down and rebuilds the screen
(`onLeave` then `onEnter`), so reopening while already showing would visibly flicker.

Leave the lag-heuristic logic in `initOnlineLockstep()` (~1030-1053) untouched — it still works
correctly as the **close** trigger. This change is purely additive: earlier open, same close.

## 5. Phase 3 — Kick/wait voting

### 5.1 Server data model

```ts
interface VoteSession {
    votes: Map<string, "kick" | "wait">;   // voter -> choice; final, never overwritten
    extensionsRemaining: number;
    chargedWaitVoters: Set<string>;         // each wait voter buys an extension exactly once
}
```

New `InstanceState` field `voteSessions: Map<string, VoteSession>`, keyed by the departed
target's nick, initialized `new Map()` alongside `departedAt` in the `instanceStates.set(...)`
object literal (~595-617). A second field, `pendingVoteOpens: Map<string, ReturnType<typeof
setTimeout>>`, tracks a drop that is still within `voteOpenDelayMillis` — a `voteSessions` entry
never exists for a nick that still has one of these pending; the timer firing (with the player
still in `departedAt`) is what actually calls `openVoteSession`. `scheduleVoteOpen()` sets it (on
drop) and `cancelPendingVoteOpen()` clears it (on rejoin, resign, or voluntary leave) — mirrors
`schedulePauseTimer`'s existing staleness-guard pattern (`instanceStates.get(gameId) !== state`)
so a timer firing against a torn-down instance is a safe no-op.

### 5.2 Config (`server/src/config.ts`)

```ts
voteMinRequiredPlayers: Number(env.GSERV_VOTE_MIN_REQUIRED_PLAYERS ?? 3),
voteExtensionsMax:      Number(env.GSERV_VOTE_EXTENSIONS_MAX ?? 2),
voteExtensionSeconds:   Number(env.GSERV_VOTE_EXTENSION_SECONDS ?? 30),
voteOpenDelayMillis:    Number(env.GSERV_VOTE_OPEN_DELAY_MILLIS ?? 10_000),
```

The >50% majority threshold is deliberately **not** configurable — computed inline as
`Math.floor(eligible.length / 2) + 1`.

### 5.3 Protocol

Following the existing one-code-per-lifecycle-event convention (804/806/807/808, 809-812), in
`server/src/protocol/gservCodes.ts` and its mirror `src/network/gservCodes.ts`:

```ts
export const RPL_VOTE_SESSION_OPENED = 813; // ":<target>,<extensionsMax>,<extensionSeconds>"
export const RPL_VOTE_UPDATE         = 814; // ":<target>,<kick>,<wait>,<extLeft>,<eligible>,<threshold>,<voter>=<choice>;..."
export const RPL_VOTE_SESSION_CLOSED = 815; // ":<target>"
```

Client → server command: `vote <targetNick> <kick|wait>`, handled by a new `case "vote":` in
`handleLine()` (~339-388).

### 5.4 Server functions

**New:** `isVotingEligible()`, `isEligibleVoter()`, `scheduleVoteOpen()`,
`cancelPendingVoteOpen()`, `openVoteSession()`, `handleVote()`, `resolveVote()`,
`resignDepartedPlayerEarly()`, and `resignDeparted()` — the last one **extracted from
`expireDeparted()`'s loop body** (the `leftNicks.add` / pending-injection / `requiredNicks.delete`
/ `RPL_PLAYER_GAVE_UP` block, ~897-919), so an early kick and a natural timeout share literal code
rather than a re-implementation.

`isEligibleVoter()` is recomputed fresh on every call rather than cached, so a second concurrent
departure automatically drops out of every other session's eligible pool with no extra
bookkeeping. `openVoteSession()` itself is unchanged from a direct call — it's `handleClose()`
that no longer calls it directly (see below).

**Modified:**
- `handleClose()` — call `scheduleVoteOpen()` (not `openVoteSession()` directly) after setting
  `departedAt`. This starts the `voteOpenDelayMillis` timer rather than opening a vote
  immediately; see §2's delay rule and §5.1.
- `handleRejoin()` — delete any open session (`closeVoteSession`) *and* cancel any still-pending
  open (`cancelPendingVoteOpen`) after `departedAt.delete()`. The latter is what makes a
  reconnect-within-the-delay never surface a vote at all — without it, a pending timer scheduled
  before the reconnect would still fire and open one. `closeVoteSession` is closed here rather
  than waiting on `RPL_PLAYER_RECONNECTED` (which doesn't fire until `handleReady()`, post-catch
  up) for the same original reason: the vote UI would otherwise stay open through the entire
  resync replay.
- `handleLeave()` — cancels any pending open too (defensive; a departed nick has no live
  connection to send `leave` with, so this path is not currently reachable, but kept for symmetry
  with every other place that ends a departure).
- `expireDeparted()` — delete the session, cancel any pending open, broadcast closed, then call
  `resignDeparted()`. The cancel only matters if `voteOpenDelayMillis` is configured larger than
  the grace window itself; the timer's own staleness guard would make a leftover pending open
  harmless either way, this just avoids a dangling Node timer.
- `finalizeInstance()` — clears every remaining `pendingVoteOpens` timer alongside the existing
  `clearPauseTimer()` call, so a torn-down instance never has a stray timer fire against it.

### 5.5 Vote-resolution algorithm

```ts
const eligible = [...state.requiredNicks].filter(n => this.isEligibleVoter(state, n, targetNick));
// tally kick/wait across eligible voters only
const hasWaitVote = waitVotes > 0;
for (const nick of eligible) {
    if (session.votes.get(nick) !== "wait"
        || session.chargedWaitVoters.has(nick)
        || session.extensionsRemaining <= 0) {
        continue;
    }
    session.chargedWaitVoters.add(nick);
    session.extensionsRemaining -= 1;
    const expiry = state.departedAt.get(targetNick);
    if (expiry !== undefined) {
        state.departedAt.set(targetNick, expiry + this.config.voteExtensionSeconds * 1000);
    }
}
const majorityThreshold = Math.floor(eligible.length / 2) + 1;
const vetoActive = hasWaitVote && session.extensionsRemaining > 0;  // read AFTER the spend
if (kickVotes >= majorityThreshold && !vetoActive) { /* resign early */ }
```

Three behaviours worth stating explicitly:

- **`waitVotes === 0` with extensions remaining resolves on plain majority** — the common case.
  `vetoActive` correctly computes false.
- **The wait vote that drains the last extension does not itself veto**, because `vetoActive`
  reads the post-decrement value. This is the literal reading of "extensions exhausted ⇒
  advisory only," evaluated at resolution time.
- **Extensions are charged against the freshly-recomputed electorate**, not at `handleVote`
  time, so a voter who was ineligible when they voted is never charged, and the ledger and the
  tally always agree on who counts.

### 5.6 Client wiring

`GservConnection.ts` gains `sendVote(targetNick, choice)` matching `sendPause()`'s
fire-and-forget shape, three new `EventDispatcher`s, and three `else if` branches in the
`handleMessage` switch (~152-182), with a `parseVoteUpdate` helper alongside the existing
`parseCountdownMillis`.

**The vote UI belongs per-row in `ConInfoForm`'s table, not in a stacked `QuitConfirmScreen`.**
`QuitConfirmScreen`'s sidebar-button pattern is designed for one-shot blocking confirmations;
votes are revotable, majority-gated, and — critically — **there can be multiple concurrent vote
sessions** (two players dropping in the same window), which a single pair of global sidebar
buttons cannot disambiguate. The connection table already renders one row per player and already
live-updates every second.

- `ConnectionInfoScreen.ts`: add `voteTallies = new Map<string, VoteTally>()`, subscribe the
  three new events in `onEnter` mirroring the existing `onLoadInfo`
  subscribe/unsubscribe/dispose pattern (~103-131), and thread into props via the existing
  `applyOptions` mechanism. The "Abort Mission" sidebar button stays unchanged.
- `ConInfoForm.tsx`: a new "Vote" column, populated only for rows where
  `voteTallies.has(player.name)`. Two buttons (Kick / Wait, highlighting the local player's
  current choice), with "Wait" greyed plus a tooltip once `extensionsRemaining === 0`, and a
  compact readout like `Kick 2/3 · Wait 1 (ext 1/2)`. A new `onVote` prop wires to
  `gservCon.sendVote`.
- **2-player games need no client special-casing** — the server never opens a session, so
  `voteTallies` stays empty and the column renders nothing.

New locale strings go in `public/res/locale/en-US.json` using the lowercase `ts:` / `gui:`
prefix convention with `%s` / `%d` placeholders (e.g. `gui:vote_kick`, `gui:vote_wait`,
`ts:vote_session_opened`, `ts:vote_extension_granted`) — not the legacy `TXT_` CSF prefix,
which is reserved for the original RA2 string table.

### 5.7 Optional — team labels

`game.gameOpts.humanPlayers[].teamId` is already available client-side. A `teamsByNick` map can
be built at the `openConnectionInfo` call sites and threaded through `GameMenu.ts` →
`ConnectionInfoParams` → `ConInfoForm` as a small "Team N" label. Purely cosmetic — fairness
comes from the wait-veto, not from team awareness — and safe to cut. No server change needed;
`GservReplayRecorder` has no `teamIdFor()` getter and doesn't need one.

## 6. Test plan

New `describe` block in `server/test/gservLifecycle.test.ts`, modelled on the existing 3-player
pause test (~520-552), reusing `setup()` / `join()` / `buildGameOpts()` and
`server.runSweepPass(Date.now() + offset)` for deterministic time travel:

1. Below-threshold roster (2 players) never opens a session; votes are silently ignored.
2. Majority kick with no wait votes resigns early, before the grace timer would fire.
3. A single wait vote extends `departedAt` by exactly `voteExtensionSeconds` and decrements the
   pool by exactly 1; a subsequent kick majority is still blocked.
4. Extension-pool exhaustion (`voteExtensionsMax` distinct players each voting wait) then falls
   back to plain majority despite standing wait votes.
5. Self-reconnect closes the session; the normal resync / `ready` / resume flow proceeds.
6. A cast vote is final: a repeat vote from the same player, same choice or different, is
   ignored and neither moves the tally nor re-earns an extension.
7. Observers and non-required players cannot vote (needs a `buildGameOptsWithObserver` helper).
8. The eligible pool shrinks correctly when a second player drops mid-vote — the newly departed
   player leaves both `eligible` and `majorityThreshold` with no explicit removal code.
9. A drop within `voteOpenDelayMillis` of reconnecting never opens a session at all — the
   pending timer is cancelled outright, not merely a session that opens-then-closes.

Every test that needs a vote to actually be open configures `GSERV_VOTE_OPEN_DELAY_MILLIS` down
to a few milliseconds and awaits a short real sleep past it, following the same real-timer
testing convention already used for `pauseCountdownMillis`/`rejoinResumeCountdownMillis` elsewhere
in this file (a `dropAndWaitForVote()` test helper wraps the common case).

New client E2E test `src/test/voteE2E.test.ts`, modelled on `rejoinE2E.test.ts`'s in-process
real-server + `FakeSocket` / `FakeIrc` + `.pump()` skeleton: a 3-player instance, drop one, cast
two kick votes, and assert the tally increments across `onVoteUpdate` payloads and that both
`onVoteSessionClosed` and `onPlayerGaveUp` fire. This exercises the full text-protocol round
trip that a server-only test cannot reach.

**Regression:** `bun test server/` and `bun test src/` must stay green; `npx tsc --noEmit` clean
apart from known pre-existing unrelated warnings.

**Manual:** 3+ clients, drop one — confirm the pause screen appears immediately rather than
after ~3s, catch-up progress is visible to waiting players on rejoin, and each vote path behaves
(majority kick, wait-veto extension, pool exhaustion, self-reconnect cancelling the session).

## 7. Sequencing

Phases 1 and 2 are independent of each other and of Phase 3, and each is shippable alone.
Phase 3 is the only piece touching the protocol, config, and `InstanceState`; landing it last
means the `ConnectionInfoScreen` / `ConInfoForm.tsx` files it shares with Phase 1 are already
stable and tested, rather than all three arriving in one diff.

## 8. Implementation checklist

### Phase 1 — Rejoiner progress bar

- [x] Add `Rejoining = 4` to `src/network/gamestate/PlayerConnectionStatus.ts`
- [x] `GservServer.sendLoadInfo()`: report status 4 for nicks in `rejoiningNicks`, with a comment
      pointing at the client enum (server does not import client code)
- [x] `GameScreen.runRejoinCatchUp()`: call `sendLoadedPercent(percent)` in the existing
      `updateProgress()` closure
- [x] `ConInfoForm.tsx`: add `loadPercent?: number` to `ConInfo`; render `<progress>` in the
      `player-time` cell when status is `Rejoining`
- [x] Server test: a rejoining nick reports status 4 with a live `loadPercent` in `RPL_LOAD_INFO`
      (mutation-tested: fails correctly when the status computation is reverted)
- [x] Verify `bun test server/` + `bun test src/` green, `tsc --noEmit` clean

### Phase 2 — Deterministic pause UX

- [x] `GameScreen.ts` `disconnectHandler`: open `ConnectionInfoScreen` immediately, guarded by
      `!(getCurrentScreen() instanceof ConnectionInfoScreen)` and `nick !== playerName`
- [x] Confirm the lag-heuristic path in `initOnlineLockstep()` still closes the screen correctly
      (left untouched by design)
- [ ] Manual check: screen appears on drop with no flicker, closes on resume — **not yet run**,
      needs a real multi-tab/multi-client session. Note: an independent review (§9, finding 1)
      already caught and fixed a guaranteed flicker/vote-state-wipe bug this check would have
      hit on the very first required-player drop — the fix is in, but hasn't been visually
      confirmed in a browser yet

### Phase 3 — Kick/wait voting

**Server**
- [x] Add the four `GSERV_VOTE_*` knobs to `ServerConfig` + `loadConfig()` (min players,
      extensions max, extension seconds, and — added after review, see §9 — open delay millis)
- [x] Add `RPL_VOTE_SESSION_OPENED/UPDATE/CLOSED` (813-815) to `server/src/protocol/gservCodes.ts`
      **and** mirror into `src/network/gservCodes.ts`
- [x] Add `VoteSession` interface + `voteSessions` field to `InstanceState`, initialized in
      `instanceStates.set(...)`; a second field, `pendingVoteOpens`, added after review (§9) to
      track a drop still within its open-delay window
- [x] **Extract `resignDeparted()` from `expireDeparted()`'s loop body first**, confirmed the
      existing suite still passed before adding anything new
- [x] Add `isVotingEligible()`, `isEligibleVoter()`, `scheduleVoteOpen()`,
      `cancelPendingVoteOpen()`, `openVoteSession()`, `resolveVote()`,
      `resignDepartedPlayerEarly()`, `closeVoteSession()` (extracted so both the kick-resolve and
      the reconnect/timeout paths broadcast `RPL_VOTE_SESSION_CLOSED` through one implementation)
- [x] Add `handleVote()` + `case "vote":` in `handleLine()`
- [x] Wire `scheduleVoteOpen()` into `handleClose()` (not a direct `openVoteSession()` call — see
      §2's delay rule); pending-open cancellation and session teardown into `handleRejoin()`,
      `handleLeave()`, and `expireDeparted()`; timer cleanup in `finalizeInstance()`
- [x] One addition beyond the original design: `handleClose()` now re-tallies every *other* open
      vote session when a required voter (not the target) drops, since their departure shrinks
      the electorate and majority threshold — otherwise a vote already past the (now-lower)
      threshold would sit unresolved until someone happened to cast another vote. Covered by
      server test case 8.

**Client**
- [x] `GservConnection.ts`: `sendVote()`, three `EventDispatcher`s, three switch branches,
      `parseVoteUpdate()` helper
- [x] `ConnectionInfoScreen.ts`: `voteTallies` map, subscribe/unsubscribe the three events,
      thread through `applyOptions`
- [x] `ConInfoForm.tsx`: Vote column with Kick/Wait buttons, tally readout, `extensionsRemaining`
      exhausted state, `onVote` prop — column and header hidden entirely when no session is open
      (added after review, §9), vote controls hidden for observer viewers (added after review, §9)
- [x] Add `gui:vote_*` / `ts:vote_*` strings to `public/res/locale/en-US.json` and `zh-CN.json`

**Tests**
- [x] Server cases 1-9 from §6 in a new `describe` block (11 tests total: case 4's "0→1→0→1
      transitions" scenario split into its own dedicated test; case 9, the open-delay/cancel
      behavior, and its regression sibling for the electorate-floor fix, both added after review)
- [x] `src/test/voteE2E.test.ts` full protocol round trip, updated for the open delay
- [x] Full regression: `bun test server/` (244 pass), `bun test src/` (43 pass / 1 pre-existing
      skip), `tsc --noEmit` (no new errors — root tsconfig's pre-existing gap around `bun:test`
      types accounts for the only delta, same class of error `rejoinE2E.test.ts` already has)
- [x] Mutation-tested every load-bearing invariant found along the way: `vetoActive`, the
      0→nonzero-only extension spend, the electorate-floor re-check in `resolveVote()`, and both
      halves of the open-delay mechanism (the delay itself, and cancellation on reconnect) — each
      confirmed to fail the suite when disabled, and to pass when restored
- [ ] Manual 3+ client smoke test of every vote path — **not yet run**, needs a real multi-tab
      session

### Optional

- [ ] Team labels (§5.7) — **not implemented**, cut as planned to keep the diff focused

## 9. Independent review findings and fixes

An adversarial second-pass review (a fresh agent, given only the diff and this doc — not the
implementation reasoning) found two real bugs, one real gap, and two cosmetic issues. All were
verified against the live code before fixing; the two testable ones were mutation-tested
(confirmed to fail without the fix, pass with it) before being marked resolved.

1. **HIGH — duplicate screen-open wiped vote state.** The immediate-open change in Phase 2 (§4)
   was only added to the disconnect-notice handler; the pre-existing lag-heuristic open call
   (`GameScreen.ts`, `onLagStateChange` → `connectionInfoTimer`) was left unguarded. Since a real
   required-player drop reliably trips both paths, the screen would reopen ~3s later, tearing
   down and rebuilding itself — silently discarding any vote tally accumulated in that window
   (`voteTallies` has no resync-on-reopen equivalent to `conInfos`' `requestLoadInfo()`).
   **Fixed**: added the same `instanceof ConnectionInfoScreen` guard to the lag-heuristic call
   site, and moved the immediate-open trigger from the general `onPlayerDisconnect` event to
   `onPlayerReconnecting` (see finding 3).

2. **HIGH — vote electorate could shrink to 1, permitting a unilateral kick.** `isVotingEligible()`
   only gated *opening* a session, checked once against `requiredNicks.size` — which does not
   shrink when a player merely drops (only resigning/leaving removes them). If a second required
   player dropped while a vote was already open, the real eligible-voter count could fall as low
   as 1, letting that single remaining player cast a "majority" kick alone — exactly what the
   3-player minimum exists to prevent, just reached via concurrent disconnects instead of
   resignations. **Fixed**: `resolveVote()` now re-checks `eligible.length + 1` (the +1 for the
   target) against `voteMinRequiredPlayers` on every recount, and closes the session outright if
   it falls below the floor (any wait extension already granted stands; only further voting
   stops). New regression test: *"a second concurrent departure closes an open vote rather than
   letting one voter carry it alone"*.

3. **MEDIUM — the immediate-open trigger fired for observer drops too**, which don't pause the
   relay, contradicting the change's own stated justification. Folded into fix 1: hooking
   `onPlayerReconnecting` instead of `onPlayerDisconnect` fixes this for free, since the server
   only ever broadcasts `RPL_PLAYER_RECONNECTING` for a required player
   (`GservServer.handleClose`'s `requiredNicks` branch) — an observer/passive drop fires
   `RPL_PLAYER_DISCONNECT` alone.

4. **LOW (cosmetic) — the Vote column header rendered permanently, even in 2-player games that
   can never have a vote.** **Fixed**: both the header and the per-row cell are now gated on
   `voteTallies.size > 0`.

5. **LOW (cosmetic) — vote buttons rendered for viewers who could never cast an effective vote**
   (e.g. an observer watching the screen), silently no-op-ing on click since the server already
   correctly rejects the vote. **Fixed**: gated on the real `Player.isObserver` field
   (`src/game/Player.ts`), already relied on elsewhere in this same menu system
   (`GameMenu.ts`'s pause-eligibility check).

Separately, the review also specifically checked and found solid (i.e. no fix needed): the vote
wire-format's parsing safety against nick names containing `,`/`;`/`=` (blocked by nick
validation at auth), the `VoteSession`/`departedAt` lifecycle pairing across every
creation/deletion path including a drop-during-rejoin-catch-up, the `handleClose` electorate
re-tally's ordering (no double-broadcast, no infinite loop), the flood/impersonation surface of
the new `vote` command (votes as the authenticated identity, subject to the existing rate
limiter), the zero-eligible-voters edge case, and the interaction between the vote-extension
deadline shift and the separate manual-pause deadline shift.

## 10. Open-delay follow-up (post-review, user-driven)

After the above review pass landed, direct product feedback identified a real design gap the
review didn't cover: the vote session opened the *instant* a required player's socket closed,
with no grace period for a brief reconnect — meaning even a 2-3 second network blip that the
lag-heuristic connection screen might show would immediately confront the remaining players with
a live kick/wait decision.

**Fixed** by decoupling "the connection screen is visible" from "a vote is offered": `handleClose`
now calls `scheduleVoteOpen()` instead of `openVoteSession()` directly, which starts a
`voteOpenDelayMillis` timer (default 10s, config `GSERV_VOTE_OPEN_DELAY_MILLIS`) rather than
opening anything. A vote only actually opens if the player is *still* departed when that timer
fires. `cancelPendingVoteOpen()` — called from `handleRejoin`, `handleLeave`, and defensively from
`expireDeparted`/`finalizeInstance` — stops the timer outright on a reconnect within the window,
so a drop that resolves itself in a few seconds never surfaces a vote at all. Full details in
§2, §5.1, and §5.4 above; test plan addition in §6 (case 9); checklist and mutation-test coverage
in §8.

This composes cleanly with everything the independent review already verified: the delay only
gates when `openVoteSession()` is first called, not its internal logic (eligibility gate, the
electorate-floor re-check from finding 2, the immediate `resolveVote()` broadcast) — none of
which needed to change.

## 11. Live playtest findings (post-implementation)

A real 2-player match surfaced three issues. Two are fixed below; the third is investigated but
not yet resolved.

### 11.1 FIXED — closing a tab silently skipped the entire pause/reconnect flow

**Symptom:** dropping a player by closing their browser tab showed a disconnect chat message but
never paused the game or opened `ConnectionInfoScreen`.

**Root cause (pre-existing, not introduced this session, but it defeated every feature in this
doc):** closing a tab fires `document.visibilitychange` (hidden) *before* the socket actually
closes. `GameAnimationLoop.handleVisibilityChange` (`src/engine/GameAnimationLoop.ts:106-148`)
reacts to that by calling `LockstepManager.setPassiveMode(true)`, which sends `active 0` to the
server. `GservServer.handleActive()` removes the nick from `InstanceState.requiredNicks` — a
legitimate optimization for a genuinely backgrounded-but-still-connected tab (don't stall the
relay waiting on someone who's just alt-tabbed). But moments later, when the real socket close
reaches `handleClose()`, its branch condition was `state.requiredNicks.has(client.nick)` — now
false, since passive already removed them — so it silently took the observer/passive branch: a
disconnect notice with **no** `RPL_PLAYER_RECONNECTING`, **no** `departedAt` grace window, and
therefore none of this doc's pause UX, progress bar, or voting ever engaged.

**Fixed** in `GservServer.ts`: added `isRequiredRosterPlayer(state, nick)` — checks
`state.recorder.playerIdFor(nick)`/`isObserver(nick)`, independent of the mutable `requiredNicks`
set — and changed `handleClose()`'s branch condition to use it instead, unconditionally re-adding
the nick to `requiredNicks` in that branch (a no-op if they were already there). Passive now
correctly means only "temporarily excused from submitting frames," never "no longer a required
player." The existing test `"relay holds while a non-required player rejoins..."` encoded the old
(buggy) behavior directly in its assertions and was rewritten —
`"a passive player who then disconnects is still treated as a full required drop"` — to assert the
fixed behavior end-to-end (drop → `RPL_PLAYER_RECONNECTING` fires → relay holds → rejoin → resume).
Mutation-tested (reverting the fix fails the rewritten test).

### 11.2 FIXED — sustained ~80s throughput collapse after a rejoin resumed

**Symptom:** after bob dropped, rejoined, and the relay resumed, both players' tick rate collapsed
to near zero (0-5 ticks/s vs. a normal ~30) for roughly 80 seconds, recovering immediately and
durably only once the *other*, still-connected player (charge) forced an unrelated full page
reload of their own.

**Root cause**, found via a dedicated investigation pass reading `LockstepManager.ts`,
`GameScreen.ts`, `GameAnimationLoop.ts`, `ConnectionInfoScreen.ts`, `HtmlReactElement.ts`, and the
relevant `GservServer.ts` paths: `ConnectionInfoScreen` is a real `react-dom` root
(`HtmlReactElement.ts:16-45` confirms `createRoot()`/`.render()`/`.unmount()`), not a cheap widget
toggle. The lag-heuristic close in `initOnlineLockstep()` closed it **instantly** on the very first
`lagState → false`, with no debounce — asymmetric with the open path, which already debounced by
`CON_INFO_THRESH_MILLIS` (2s). Under a genuinely flapping connection (throughput oscillating around
the `LAG_STATE_THRESH_MILLIS` 1s stall threshold — exactly what a struggling client produces), the
screen would mount and unmount on every single flap, at real React-reconciliation cost, on the
connected peer's own client, competing for the same main thread that needs to call
`sendActions()` every animation frame. This is self-reinforcing: heavier main thread → later
submission → lower relay throughput → more flapping → repeat — which explains both the ~80s
*duration* (a resonance loop, not a fixed cost) and why only a **full reload** cleared it (a fresh
load has no accumulated lag state to resonate with, rather than needing to win a specific timing
race).

A second, confirmed but secondary bug compounded it: the per-lagState-event handler called
`this.disposables.add(() => connectionInfoTimer?.cancel?.())` **inside** the event body
(`GameScreen.ts`'s `initOnlineLockstep`), so every single `lagState → true` transition for the
life of the match appended a fresh closure to the screen-level `CompositeDisposable` — an unbounded
leak, real but too small on its own to explain an 80-second collapse.

**Fixed**, both in `GameScreen.ts`'s `initOnlineLockstep()`:
- The open/close decision was unified into one `scheduleConnectionInfoTransition(open: boolean)`
  helper that debounces **both directions** by the same `CON_INFO_THRESH_MILLIS`, canceling
  whatever transition is still pending whenever a new `lagState` event arrives. A lag state that
  flaps within the debounce window now never touches the DOM at all — it just keeps deferring.
- The disposer is now registered **once**, outside the event handler, closing over the same
  mutable `connectionInfoTimer` reference — fixing the leak with no behavior change (it already
  always canceled whatever the *current* timer was).

This is a mitigation grounded in a well-evidenced mechanism (repeated real mount/unmount cost,
confirmed via code reading), not a certainty proven by a reproduction — the investigation's
recommended verification (timestamped client logs on every `onLagStateChange` transition and
`ConnectionInfoScreen.onEnter`/`onLeave`, correlated with a browser performance trace during a
repro) has not been run. No automated regression test was added: this logic depends on
`LockstepManager`/`Task`/`GameMenu` machinery with no existing unit test harness in this codebase
(confirmed — `GameScreen.ts` has no dedicated test file), so verification is `tsc`/full-suite
regression only (unaffected, both green) plus the reasoning above. **A live retest under a
genuinely flapping connection is the only way to confirm this actually resolves the collapse.**

### 11.3 NOT YET RESOLVED — rejoin loading screen shows the wrong player order

**Symptom:** on bob's own client while catching up after a rejoin, the loading screen's player
list didn't show bob first.

**Investigated, not fixed.** `MpLoadingScreenApi.createExtendedLoadingInfos()`
(`src/gui/screen/game/loadingScreen/MpLoadingScreenApi.ts:210-223`) already has explicit
"local player must always be listed first" logic — a `findIndex` + `splice`/`unshift` keyed on
`this.localPlayerName`, set once via `.start(players, mapName, localPlayerName)`
(`GameLoader.ts:32`), sourced from `GameScreen.ts`'s own `playerName` field
(`params.playerName`/`lanLaunch?.localPlayerName`, consistent for both a fresh join and a rejoin's
fresh reload). In isolation this logic looks correct, and this file is untouched by anything built
in this doc. Not conclusively root-caused within this investigation's scope — needs its own
dedicated follow-up (most likely: verify `localPlayerName` actually matches a name in
`extendedInfos` at rejoin time; a mismatch would make `findIndex` return -1 and silently skip the
reorder).

## 12. Post-fix review: leave-then-close regression

A review pass over the §11.1 fix caught a regression it introduced, now fixed.

**The bug.** `isRequiredRosterPlayer()` deliberately stopped consulting `requiredNicks` (that was
the whole point — a passive player is still a required player). But `requiredNicks` membership had
been carrying a second, unnoticed meaning: it also excluded players who were *no longer in the
match at all*. `handleLeave()` and `resignDeparted()` both remove a nick from `requiredNicks` for
good, and the roster check has no equivalent notion of "already gone".

That matters because **"Abort Mission" always produces a `leave` followed a moment later by a
`close` on the same socket** — the client sends the command, then the page tears the connection
down. With the roster check alone, that trailing `handleClose()` looked like a fresh mid-game
drop: the player who had just resigned was re-added to `requiredNicks`, given a 30s grace window,
announced to everyone as `RPL_PLAYER_RECONNECTING`, and had a kick/wait vote scheduled on them.
The relay froze for the full grace window waiting on someone who was never coming back, then
`expireDeparted()` resigned them a second time (a duplicate `RPL_PLAYER_GAVE_UP`, and a
`RESIGN_ACTION_BLOB` injected for an already-resigned player).

**The fix.** `isRequiredRosterPlayer()` now also requires `!state.leftNicks.has(nick)`.
`leftNicks` is the durable "out of this match for good" marker — set by both `handleLeave()` and
`resignDeparted()` — so it covers the voluntary quit and the resigned/kicked player alike, while
staying completely orthogonal to passive status.

**Test:** `"the socket closing after a voluntary leave does not reopen a rejoin window"` in
`server/test/gservLifecycle.test.ts`. Confirmed to fail without the fix
(`requiredNicks.has("bob")` came back `true` after leave+close) and pass with it.

## 13. Known gaps (found in review, not yet fixed)

Ordered by severity. Nothing here is a regression from §11/§12 — these are things the
implementation never covered.

### 13.1 The vote UI has no CSS at all — HIGH

`ConInfoForm.tsx` renders `.player-vote`, `.vote-controls`, `.vote-choice`,
`.vote-choice-selected`, `.vote-tally` and `.player-rejoin-progress`. **None of these exist in
`public/css/main-legacy.css`.** Consequences:

- `#ra2web-root .con-info-form td { width: 70px }` (main-legacy.css:2428) applies to the vote
  cell, which holds two buttons plus a tally span. It will overflow or wrap badly.
- The buttons are bare `<button>` elements. Every other button in this UI uses the sprite-sheet
  pattern (`.dialog-button`, main-legacy.css:393-414 — `background-image: var(--res-mnbttn)`,
  fixed 126x25, `:hover`/`:active` via `background-position`). Unstyled ones will look nothing
  like the rest of the game.
- **`.vote-choice-selected` having no rule is a functional gap, not just cosmetic**: it is the
  only affordance telling you which way you already voted.
- `<progress class="player-rejoin-progress">` is unstyled native chrome inside a 70px cell.

This has never been seen because the vote UI needs three human players to appear at all.

### 13.2 A departed player is resigned mid-pause — HIGH (pre-existing)

`expireDeparted()` (GservServer.ts:1216) has no `state.paused` guard, and `runSweepPass()`
(line 197) calls it unconditionally. The compensating shift that pushes `departedAt` deadlines
forward by the paused duration only runs **on resume** (line 1116-1126) — by which time the
entry has already been deleted and the player resigned.

`handlePause()` (line 1049) does not refuse a pause while someone is departed, so this is
reachable: player drops → someone pauses → 30s later the sweep resigns the departed player
while the game is still frozen.

Confirmed with a throwaway probe: drop bob, pause, `runSweepPass(now + 40s)` →
`leftNicks.has("bob") === true`, `requiredNicks === "alice"`.

This predates all of this work, but it defeats the pause UX in §4 and would silently nullify a
wait-vote extension. Fix is one guard in `expireDeparted`, plus deciding whether the paused
duration should also be credited to deadlines while still paused (for the countdown the client
renders from `timeoutAt`).

### 13.3 Catch-up progress is broadcast ~20x/sec with per-member fanout — MEDIUM

`runRejoinCatchUp`'s `updateProgress()` (GameScreen.ts:1662-1673) fires every 50ms chunk, and
each `sendLoadedPercent` reaches `handleLoaded` → `broadcastLoadInfo` (GservServer.ts:629-635,
1311-1321), which sends one `RPL_LOAD_INFO` **per member**, each line carrying a row per roster
player. So ~20 sends/sec × N members, sustained for the entire catch-up.

The rejoiner's own outbound is fine (20/s against a 200/s refill, 600 capacity — GservServer.ts:
41-42). The waste is the fanout, and it is almost entirely redundant: `ConnectionInfoScreen`
already polls `requestLoadInfo()` on a 1s interval (ConnectionInfoScreen.ts:170), so waiting
players would see the bar move at 1Hz regardless. A 20Hz push is imperceptible on a progress bar.

Fix: only send when the integer percent actually changes — caps the whole catch-up at 100 sends
instead of 20/sec for its full duration.

Worth noting given §11.2: this amplification is concentrated in exactly the window where the
original tick-rate collapse was observed.

### 13.4 A reopened Connection Info screen shows a blank vote column — LOW

`voteTallies` is seeded only from live `RPL_VOTE_*` events, and there is no request/response for
current vote state the way `requestLoadInfo()` exists for load info. If the lag path closes the
screen while a vote is open, the reopen (which does happen — a held relay drives `lagState` true
again) starts with an empty tally and stays blank until someone casts the next vote.

Note the screen cannot be dismissed by the player: `ScreenType.ConnectionInfo` has no entry point
anywhere in the in-game menu, and its only sidebar button is Abort Mission. So this is reachable
only via the automatic close, which bounds how bad it gets.

Fix would be a `RPL_VOTE_UPDATE` rebroadcast on `loadinfo` request, or a dedicated vote-state
query.

### 13.5 Observers see an empty Vote column — LOW

`hasOpenVote` (ConInfoForm.tsx) gates the column header on `voteTallies.size > 0` alone, while
the cell contents are additionally gated on `!localPlayer.isObserver`. An observer watching a
game with an open vote therefore gets a "Vote" header over empty cells. Fold `isObserver` into
`hasOpenVote` to drop the column entirely for them.

## 14. Final votes and per-voter extensions

A vote is now **final**: once cast it cannot be changed or withdrawn.

**Why.** Two persistent buttons plus a running tally never fit the vote cell (§13.1) — the
column inherits `#ra2web-root .con-info-form td { width: 70px }`. A control that collapses into
a count once used is naturally narrow, removes the "which one did I pick" ambiguity, and closes
the flip-flop abuse vector outright.

**What it forced.** The extension pool was built on revoting: an extension was spent on each
zero→nonzero wait-vote transition. With final votes the wait count can never fall back to zero,
so that rule could only ever spend **one** extension — any `voteExtensionsMax` above 1 was dead
config, and the "extensions exhausted ⇒ wait goes advisory ⇒ kick carries" path was unreachable.

So the rule changed to **one extension per distinct wait voter**, capped at `voteExtensionsMax`.
Each player voting wait buys `voteExtensionSeconds`, once. This keeps the whole pool reachable,
states the rule plainly enough to put in a tooltip, and preserves the hard cap: total purchasable
time is still `extensionsMax × extensionSeconds` no matter the roster size.

`VoteSession.hadWaitVote: boolean` became `chargedWaitVoters: Set<string>`.

**Enforced server-side.** `handleVote` refuses a second vote from a nick already in
`session.votes`. Hiding the buttons is not enough on its own — without the server check a
modified client could still flip between kick and wait to keep re-earning extensions, which is
precisely what the per-voter charge exists to prevent.

**Tests.** `"each wait voter buys one extension, and only one"`, `"a cast vote is final: a second
vote from the same player is ignored"`, and `"each player's vote counts exactly once"` in
`server/test/gservLifecycle.test.ts`. Both new guards were mutation-tested: removing the finality
check fails the finality test, and removing the `chargedWaitVoters` guard fails two extension
tests.

### 14.1 Vote column styling (closes §13.1)

`main-legacy.css` gained rules for `.player-vote`, `.vote-controls`, `.vote-choice`,
`.vote-cast`, `.vote-tally` and `.player-rejoin-progress`. The cell widens to 108px, and the
buttons take the row's player colour through `currentColor` so they read as belonging to the
player being voted on.

One structural fix went with it: the row-level `opacity: 0.5` applied to a disconnected player
was an **inline style on the `<tr>`**, which creates a stacking context its children cannot
climb out of — so the vote controls, which live on exactly that (departed) player's row, were
dimmed along with it. The dimming moved to a `.player-row-absent` class whose CSS rule exempts
`td.player-vote`.
