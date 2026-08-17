# Server-Authoritative Match Simulation — Investigation & Experiment Plan

**Status:** Proposal — not implemented. No code changes have been made for this feature yet.

**Audience:** engineers working on the RA2 Web TS port and the WOL/gserv server.

**TL;DR.** Deterministic lockstep is bandwidth-cheap but structurally lags behind the
slowest peer, and one player's connection problem can stall or break the whole match.
Moving simulation authority to the server fixes both failure modes. Full
server-authoritative *snapshot* networking (FPS style) is the wrong fit for this engine
(it would require serializing the entire object graph every tick); the right model is
**server-authoritative lockstep** — the server runs the *same* deterministic `Game`
simulation as the authority while clients keep local sim copies. This codebase is
unusually well positioned for it: the simulation has zero rendering/DOM dependencies
(runs in Bun), the gserv server already retains the full turn log and rejoin/resync
protocol, and the PRNG seeds are already shared (`gameId` + `timestamp`). This document
proposes building it as an **isolated experiment mode** (separate server path + opt-in
client flag) so the production relay path is never at risk.

## 1. Motivation

Two recurring pain points with the current model:

1. **Syncing lag.** Every client waits for every peer's turn batch before advancing
   (`LockstepManager.canAdvanceNetworkTurn`, `docs/online-play.md` §1 "all clients wait
   for the slowest peer each tick"). One player on a bad connection stalls the match for
   everyone, every tick.
2. **Connection issues breaking the game.** A dropped peer triggers either a global
   freeze (rejoin grace hold, `docs/reconnect-resume.md` §6.3) or a forced drop with
   `NO_ACTION` backfill; a desync is fatal; the host/relay topology determines who
   survives a disconnect.

Goals of the experiment:

- Prove that the server can simulate a match bit-identically to the clients.
- Prove that the game keeps running when a client falls behind or drops (no global
  stall, clean rejoin mid-game).
- Prove that the server can enforce state (hash verification) and later validate
  actions — groundwork for anti-cheat on the ranked ladder.
- Do all of the above **without touching** the LAN/P2P path or the production relay
  path, so it can be abandoned or promoted on evidence.

## 2. Investigation findings

### 2.1 How multiplayer works today (verified in code)

| Layer | Mechanism | Files |
|---|---|---|
| Client turn loop | Deterministic lockstep: turn N advances only when the turn-N batch of *every* active peer has arrived; hash sent every ~1 s of sim time | `src/network/gamestate/LockstepManager.ts` |
| Online transport | WebSocket to gserv; server **relays** turn blobs, performs no simulation or validation | `server/src/gserv/GservServer.ts`, `src/network/GservConnection.ts` |
| Server turn bookkeeping | `pending` map per turn; `flushPendingTurns` fires when all `requiredNicks` submitted; `turnLog` retains every resolved turn for rejoin | `GservServer.ts:66-83`, `:760-793` |
| Rejoin / resync | Full turn-log replay from turn 0 + hash verification + `ready <turnNo>`; match **pauses** during the grace window | `docs/reconnect-resume.md`, `GservServer.ts:414-462,557`, `GservConnection.ts:289-313` |
| Determinism | Fixed-point/integer math only in sim state, shared PRNG, hash check `game.getHash()` | `src/game/Prng.ts`, `src/util/math.ts` (`fnv32a`), `docs/online-play.md` §7 |
| AI | AI players are part of the shared deterministic sim (`Ai`, `BotManager`) | `src/game/ai/`, `src/game/BotManager.ts` |

### 2.2 Why the current model stalls

- Per turn, the relay only flushes when **all** expected nicks have submitted
  (`requiredNicks`). The slowest peer's round-trip time sets the tick rate for everyone.
- The client's own 2-turn lookahead (`currentNetworkTurn - 2`) hides only *constant*
  relay latency; it does not help when a peer stops submitting.
- Rejoin currently *pauses the match on purpose* (grace hold) — safe but explicitly
  "everyone freezes while one player reconnects".

### 2.3 Architecture options considered

**Option A — Server-authoritative snapshots (FPS model).** Server simulates; clients
send inputs and receive world state deltas; own units need client-side prediction +
reconciliation; enemy units render ~1 RTT late.

- *Against:* the game has no state serializer, and the object graph is huge — every
  unit/building/timer/RNG/AI state. `docs/reconnect-resume.md` §3 already documents why
  snapshots are impractical here ("any missing detail instantly desyncs"). Bandwidth
  scales with entity count. This is a rewrite of the network layer and the sim's state
  access patterns. **Rejected for this engine.**

**Option B — Server-authoritative lockstep (Factorio model).** The server runs the
same deterministic sim as the authority. Clients keep local sim copies (so gameplay
feels identical to today) and send inputs through the server. The server resolves turns
on **its own clock**, never waiting for slow peers; a peer that falls behind resyncs
from the server's retained state; hash comparison is server-enforced.

- *For:* bandwidth stays proportional to inputs (tiny); determinism constraint already
  satisfied and already enforced client-side; the server already owns the turn log and
  the resync protocol; reconnection and anti-cheat fall out naturally.
- *Against:* server pays one full simulation per match (CPU + RAM); server becomes a
  single point of failure (mitigated later by state persistence/redundancy); Bun
  (JavaScriptCore) vs browser (V8) determinism must be proven (see §3.4).

**Option C — Keep relay lockstep, only improve the pause policy** (stop holding the
relay; backfill `NO_ACTION` quickly; rely on existing resync for rejoins).

- *For:* smallest change.
- *Against:* still no authoritative verification (any client can cheat), desync remains
  fatal, and the "slowest peer" pacing problem is only mitigated, not solved.
- *Note:* this is a natural **stepping stone** — M1 in §7 does exactly this while the
  server learns to simulate in parallel.

**Decision: Option B**, reached in phases (M0→M2), with Option C behavior as M1.

### 2.4 Feasibility evidence specific to this codebase

Verified while researching:

1. **The simulation is headless-clean.** `src/game/` has zero imports of `three` and
   zero uses of `window`/`document`/`localStorage`/`navigator` (only `src/game/math/*`,
   which are three.js math re-exports, and `src/game/ai/thirdpartbot` are excluded from
   that claim — see §6 risks). `GameFactory.create()` (`src/game/GameFactory.ts:67`)
   builds a `Game` purely from data (map file, INI files, gameOpts, seeds) — the same
   call the browser makes (`src/gui/screen/game/GameLoader.ts:250`). **The exact
   simulation the browser runs can run inside Bun.**
2. **PRNG seeds are already shared.** `randomSeed1/2` passed to `GameFactory.create`
   are the `gameId` and `timestamp` from the `STARTG` handoff (`GameLoader.ts:250`),
   which the server already allocates and stores (`server/src/gserv/GservManager.ts`).
   No new seed protocol needed.
3. **The server already has most of the machinery.** Turn submission collection,
   per-turn `turnLog` retention, `RPL_RESYNC` + resync log serving, `ready <turnNo>`,
   `NO_ACTION` backfill, drop/grace handling, replay writer — all exist in
   `server/src/gserv/`. `gameoptCodec.ts` already implements the *server-side* action
   blob serialization (`serializeAllPlayerActionBlobs`, `NO_ACTION_ID`).
4. **Client hash submissions are currently ignored.** Clients already send
   `game.getHash()` per hash-check interval (`GservConnection.sendGameStateHash`,
   `LockstepManager.doGameTurn`); the relay stores nothing from them. That is the
   free hook for server-side verification — no client protocol change needed to
   validate.
5. **Server-side action application has a reference implementation.** The resync
   path already deserializes and applies action blobs server-side-adjacent (the replay
   recorder feeds them to the client catch-up loop; the pattern
   `parseAllPlayerActions` → `actionFactory.create` → `action.process()` is
   `LockstepManager.processActions`). The server needs the same loop.

### 2.5 Gaps to close (things the server does *not* have today)

| Gap | Detail | Proposed fix (v1) |
|---|---|---|
| Map bytes | Maps are client-local in this deployment; the server never receives them | Client uploads map bytes at match start (reuse the LAN `map-offer`/`map-chunk` base64 pattern, or a new binary command) |
| Rules/art/AI INI data | The client loads `rules.ini`/`art.ini`/`ai.ini` + mixin rules from local assets/CDN | Client uploads the resolved INI set alongside the map; later, serve from a `wgameres`-style server-side store |
| Turn pacing authority | Server only flushes when everyone submitted | New sim policy: resolve on server clock, backfill missing (`NO_ACTION`), never hold |
| Client state sync on gaps | No mechanism for a client that missed turns while live | Reuse `RPL_RESYNC` turn-log replay (already implemented) with the pause removed |
| Hash enforcement | Hashes relayed but never compared | Server compares client hashes vs its own sim hash at the same intervals |

## 3. Proposed experiment architecture

### 3.1 Model

```
Clients (browsers, V8)              Server (Bun, JavaScriptCore)
┌──────────────────────────┐        ┌─────────────────────────────────┐
│ local Game sim           │        │ authoritative Game sim         │
│ (same code, same inputs) │        │ (same code, same seeds)        │
│                          │        │                                 │
│ input → turn batch ──────┼───────►│ collect per-turn submissions    │
│                          │        │ resolve on server clock        │
│ resolved batch ◄─────────┼─────── │ (backfill NO_ACTION if late)    │
│ apply + advance          │        │ broadcast resolved batches      │
│ send hash every ~1s ─────┼───────►│ compare hash vs own sim →       │
│                          │        │   RPL_GAME_DESYNC on mismatch   │
│ rejoin: RPL_RESYNC ◄─────┼─────── │ turnLog: full replay for laggards│
└──────────────────────────┘        └─────────────────────────────────┘
```

- Clients behave almost exactly as today (local sim, apply own + peer actions each
  tick) — which is why perceived input latency does not degrade: the client keeps
  running its own sim at its own pace and *fast-forwards* (existing catch-up
  machinery) instead of stalling when it falls behind.
- The server's sim is the truth. A client's sim that diverges (or is suspected of
  cheating) is detected by hash comparison and rejoined via resync.

### 3.2 Isolation: how the experiment stays separate

**Server side** — new gserv variant, same binary:

- New WebSocket path **`/gserv-sim`** alongside `/gserv` (`server/src/index.ts` wiring).
- All sim code lives under **`server/src/gservSim/`**; `server/src/gserv/` (the relay)
  is untouched except for shared codecs/constants.
- Enabled by env flag **`GSERV_SIM=1`** (default off). `STARTG` allocates the sim
  variant only for matches created in the experiment lobby.

**Client side** — opt-in:

- New config.ini flag, e.g. **`simServer=yes`** in the server entry, which the client
  uses to (a) prefer `gservUrl` variants pointing at `/gserv-sim` and (b) enable the
  upload of map+rules bytes before `loaded`.
- All new client code lives in `src/network/sim/` (new) plus small guarded hooks in
  `GservConnection`/`GameScreen`. LAN P2P path (`src/network/lan/`) is **not touched**.
- A dedicated test screen (`src/tools/`) or the existing `debug:*` script pattern for
  driving it without the full WOL lobby.

**Naming:** "sim mode" vs "relay mode" everywhere (logs, stats, docs).

### 3.3 Protocol changes (additive, gated to `/gserv-sim`)

| Command | Direction | Purpose |
|---|---|---|
| `sim-data <digest>` + binary chunks | client → server | Upload map bytes + resolved rules/art/ai INI set before `loaded` (v1; LAN-style chunking) |
| (reuse) `loaded`, `loadinfo`, `active` | both | Loading progress, unchanged |
| (reuse) binary action frames | client → server | Unchanged wire format (`REQ_BIN_GAME_ACTIONS`, u32 turnNo + blob) |
| (reuse) binary hash frames | client → server | Unchanged (`REQ_BIN_GAME_STATE_HASH`); now **validated** |
| (reuse) `RPL_RESYNC` / resync log / `ready <turnNo>` | server → client | Unchanged; now also used for *live* catch-up of lagging clients, not only rejoin |
| (new) `RPL_SIM_POLICY <noHold|hold> <timeoutTurns>` | server → client | Announces pacing policy so clients set expectations (lag UI, no "connection issue" dialog while a peer is resyncing) |
| (new, later) `RPL_DESYNC_TURN <turnNo>` | server → client | Extends `RPL_GAME_DESYNC` with the offending turn (helps M0/M1 forensics) |

The relay path `/gserv` **never** speaks any `sim-*` command.

### 3.4 Determinism risk: Bun (JavaScriptCore) vs browser (V8)

The simulation deliberately avoids floats in state (`docs/online-play.md` §7), and
`getHash()` is built on integer math (`fnv32a`). Still, JSC and V8 differ in float
semantics, `Math.random` (not used — PRNG is custom `src/game/Prng.ts`), and JIT
optimization of edge behavior (e.g. `%` on negative numbers is unspecified only for
floats; integer ops are safe). **M0 is explicitly a determinism spike**: run the same
fixed input sequence (fixture map + scripted actions) in Bun and in the browser
(replay a recorded skirmish through `ReplayTurnManager`) and diff per-turn hashes.
Any divergence found there is resolved before any network code is written.

## 4. Implementation plan

Phased; each milestone has explicit deliverables and an acceptance test. No milestone
changes the production relay path.

### M0 — Determinism spike (smallest possible experiment)

- Build a Bun-side runner that constructs a `Game` via `GameFactory.create` with a
  fixture map + INI set + fixed seeds and advances N ticks, recording `getHash()` per
  turn. No network.
- Prove Bun hash sequence == browser hash sequence for: (a) a recorded skirmish replay,
  (b) a synthetic scripted action stream, (c) a match with AI players.
- **Deliverables:** `server/src/gservSim/spike/runner.ts`, `bun run sim:spike`,
  `server/test/sim-determinism.test.ts`.
- **Acceptance:** hash-identical to the browser across all three cases, including AI
  matches; write-up of any JSC/V8 divergences found.
- **Gate:** if determinism cannot be achieved with reasonable effort, the experiment is
  abandoned here with a documented reason (Option C remains the fallback).

### M1 — Parallel validation (server sims; clients unchanged)

- `/gserv-sim` path accepting the same protocol as `/gserv`, plus `sim-data` upload
  (map + INI). Server constructs the authoritative `Game`, feeds each resolved turn's
  blobs through `processActions` (port of `LockstepManager.processActions` to the
  server, reusing `gameoptCodec`), advances its sim on the same turn cadence, computes
  hashes at the same intervals, and **logs** (does not yet enforce) mismatches.
- Pacing is *unchanged* (server still waits for all nicks), so a live game behaves
  identically to relay mode — this milestone only proves the server sim stays in lock
  step with the clients.
- **Deliverables:** `server/src/gservSim/SimMatch.ts` (sim lifecycle + turn feed),
  `SimHashValidator.ts`, `wol-sim-test.ts` (two real clients through the lobby),
  unit tests with fake sockets mirroring `server/test/`.
- **Acceptance:** 10+ live test matches with zero un-explained hash mismatches; stats
  per match (turn rate, hash-check interval drift).

### M2 — Server-paced authority (the actual experiment)

- **No-hold pacing:** server resolves turns on its own clock. Late submissions get
  `NO_ACTION` backfill once `timeoutTurns` behind (config
  `GSERV_SIM_LATE_TURNS`, default e.g. 8 — same magnitude as `TURN_WINDOW`). The relay
  never blocks on a missing peer.
- **Live catch-up:** a client that fell behind (spike, tab freeze, network blip) is
  admitted through the existing `RPL_RESYNC` path — replay `turnLog`, hash-verify,
  `ready <turnNo>`, resume live. The rejoin grace *hold* is disabled in sim mode
  (`GSERV_SIM_NO_HOLD=1`); the match keeps running.
- **Hash enforcement:** mismatch → `RPL_GAME_DESYNC` (client already handles it) with
  turn number; server-side stats count mismatch rates per nick.
- **Deliverables:** pacing policy + stats; client hook to (a) suppress the
  connection-issue dialog while a peer is in resync (already partially built per
  `reconnect-resume.md`) and (b) request resync when the server says it skipped turns.
- **Acceptance tests (scripted):**
  1. One client freezes for 5 s → match continues; client returns via resync, hash
     verified, no other client ever stalled.
  2. Client drops mid-game → match continues, their units idle per policy; rejoin
     mid-game succeeds without pausing anyone.
  3. A tampered client (modified local sim) is detected by hash mismatch within the
     check interval.
- **Exit criteria for the experiment:** measured stall time per match, max resync
  time, CPU/RAM per match, and bandwidth — compared side-by-side against relay mode on
  the same maps/players.

### M3 — Smoothness & UX (optional, only if M2 measurements demand it)

- Client-side fast-forward when behind (reuse `runRejoinCatchUp` machinery at a
  smaller scale) instead of waiting.
- Lag indicator reworked: "player X resyncing" (percent) instead of global stall.
- Spectator/save-state hooks *if* the server state access pattern makes it cheap —
  otherwise deferred; not required for the experiment's thesis.

### M4 — Decision gate & cleanup

- Evaluate M2 exit criteria against goals in §1. Promotion path: move `/gserv-sim` to
  `/gserv`, flip default, keep relay mode as fallback config. Abandonment path: remove
  `server/src/gservSim/` + client `src/network/sim/` + flags, zero residue in the
  production paths.
- Either way, M0–M2 test suites stay (determinism + sim policy tests remain valuable
  regression coverage).

## 5. Open questions

1. **Map/rules provisioning.** Client upload (v1) vs server-side `wgameres` mirror
   (the `wgameresUrl` config already exists client-side) vs CDN. Upload keeps the
   experiment self-contained but costs a few hundred KB per match; mirror is the
   production shape.
2. **Rejoin while away.** Sim mode keeps running for a dropped player (their units
   idle/AI-supervised?). Policy: idle only, or hand units to the bot layer?
   (`BotManager` exists; supervised AFK is a small feature.)
3. **Ranked integrity.** Hash enforcement is the first anti-cheat layer; action-level
   validation (reject impossible orders server-side) is a later layer. Scope for M2:
   hashes only.
4. **Server failure.** Single point of failure accepted for the experiment. Persisting
   `turnLog` + periodic sim state to disk (already partially there via the replay
   recorder) makes restart-resume feasible later.
5. **Determinism edge scope.** `src/game/ai/thirdpartbot` and `src/game/math/*`
   (three.js math re-exports) are excluded from the "headless clean" claim; verify
   whether the sim path actually touches them, and whether float behavior there can
   affect `getHash()` (it must not, per §2.4.1).

## 6. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| JSC vs V8 sim divergence | Medium | High (thesis dies) | M0 spike first; integer-only hash path; document and pin any float-bearing code |
| Map/INI upload is slow or huge | Low | Medium | Chunked transfer (LAN pattern exists); only resolve needed INIs |
| Server CPU cost per match | Medium | Medium | Measure in M2; sim is the same cost as one client (which every client already pays); thread/tick batching later |
| Relay path regressions | Low | Critical | Full isolation (`/gserv-sim`, own module dir, flags default off); existing gserv test suites must stay green |
| Action semantics differ when backfilled (`NO_ACTION` on late peers) | Medium | Medium | Reuse existing backfill code (`expireDeparted`); document behavior; test scenario 2 covers it |

## 7. Work item map (rough, per milestone)

```text
M0  server/src/gservSim/spike/runner.ts          # headless game boot + tick + hash dump
    server/test/sim-determinism.test.ts          # bun-vs-browser hash equality
M1  server/src/gservSim/SimMatch.ts              # authoritative sim lifecycle + turn feed
    server/src/gservSim/SimHashValidator.ts      # hash compare + stats
    server/src/index.ts                          # /gserv-sim path (flag-gated)
    server/src/protocol/  (sim codes)            # RPL_SIM_* / sim-data (additive)
    src/network/sim/SimDataUploader.ts           # client map+INI upload (guarded)
    scripts/wol-sim-test.ts                      # real-socket sim match test
M2  server/src/gservSim/SimPacer.ts              # no-hold turn resolution + late backfill
    src/network/sim/SimCatchUp.ts                # live resync trigger (guarded)
    GservConnection / GameScreen guards          # sim-mode behavior switches
M3  (as needed) fast-forward + UX polish
M4  metrics harness + decision write-up
```

## 8. References

- This repo: `docs/online-play.md`, `docs/networking.md`, `docs/reconnect-resume.md`,
  `docs/wol-irc-and-modernization.md`, `server/README.md`
- Client lockstep: `src/network/gamestate/LockstepManager.ts`,
  `src/network/lan/LanMatchSession.ts`, `src/network/lan/LanLockstepTurnManager.ts`
- Server relay: `server/src/gserv/GservServer.ts`, `server/src/gserv/GservManager.ts`,
  `server/src/gserv/replay/*`
- Game construction: `src/game/GameFactory.ts`, `src/gui/screen/game/GameLoader.ts`
- Industry precedent: Glenn Fiedler, *Deterministic Lockstep*
  (gafferongames.com) — why lockstep waits for the slowest peer and hitches under
  packet loss; Factorio Friday Facts #76/#99 and the Factorio wiki *Multiplayer* page —
  the real-world move from P2P lockstep to server-relayed, server-paced lockstep with
  latency hiding and resync.
