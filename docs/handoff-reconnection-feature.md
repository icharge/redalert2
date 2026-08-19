# Handoff: Reconnection Feature — Desync Root Cause & Diagnostics

## Where this picks up from

Continuing an OpenCode session (`ses_ff51a3b87ffeLDm1XwKvsIPBTo`, "Confirm page
navigation") that got deep into debugging a multiplayer desync bug that only fired
right after a mid-game reconnect. That earlier session got stuck chasing a red herring
(server turn-count timing) and was picked up fresh in this Claude Code session.

**Repo:** `/Users/norrapat/development/my-experiment/redalert2-worktrees/game-0.83.2-ds`
(RA2 Web — a TypeScript port of a WebAssembly RTS, with a custom WOL/gserv replacement
server in `server/`). Not a git worktree checkout issue — this is the actual working
directory.

**Branch:** `feat/reconnect-resume`, created off `feat/wol-lobby-server`'s HEAD
(8ca96a7) this session. Two commits on top:
- `52e78b1` — the actual bug fixes (see below)
- `f99eef6` — docs update (`docs/reconnect-resume.md`, new "Post-v1 playtest fixes"
  section)

Neither commit is pushed to origin. No PR opened yet.

## What was found and fixed (all committed, all tested)

Full technical writeup already lives in `docs/reconnect-resume.md` under
"Post-v1 playtest fixes (2026-08-17/18)" — read that instead of re-deriving it. Short
version:

1. **Root cause of the desync**: `Game.status` (`src/game/Game.ts`) was declared but
   never initialized in the constructor, so it was `undefined` instead of
   `GameStatus.NotStarted` (`0`). The live-join guard in `GameScreen.ts`
   (`if (game.status === GameStatus.NotStarted) game.start()`) therefore never passed,
   so `botManager.init()` / `triggers.init()` never ran for a live-joined player. Both
   connected clients played the whole match with an inert bot (same broken state on
   both sides → hashes still matched → no desync flagged) until a reconnect's
   *unguarded* `game.start()` call in `runRejoinCatchUp` finally activated the bot for
   just the rejoining client, causing immediate divergence. Fixed by initializing
   `this.status = GameStatus.NotStarted` in the constructor. **Confirmed via user's own
   console log**: zero `[BotManager]` lines at live start, full bot lifecycle only
   firing during rejoin catch-up.
2. **Passive-reactivation gap**: `GameAnimationLoop` correctly calls
   `setPassiveMode(true)` when a browser tab is backgrounded (this is original upstream
   behavior — verified byte-identical against `downloaded-game-js/extracted/`, not a
   port bug). But `GservServer.handleActive` only handled `active: false`; it never
   re-added the nick to `requiredNicks` when `active: true` came back in. Once
   backgrounded, that player's turns were permanently rejected as stale
   (`ignoring stale turn N from <nick>`, forever), even though the connection never
   dropped. Fixed by mirroring `handleReady`'s re-admission logic. **User's test setup
   runs both players via separate browser windows (Chrome + Edge) on the same Mac**, so
   backgrounding is a routine occurrence there, not an edge case.
3. **Desync-debug export was fully dead**, across four independently-stacked bugs (see
   doc for detail): `debugGameState` never actually read from `config.ini` (a
   `MockConsoleVars` pre-population issue in `Gui.ts`/`Application.ts`);
   `handleGameError` never invoked the `debugDataProvider` callback at all;
   the shared, whole-session `WorkerHost` got permanently disposed after the first
   export attempt (killing future map loads too); `WorkerHost.queueTask` had no-op
   `resolve`/`reject` stubs so task failures were silently swallowed; and
   `compressFile`'s `7z-wasm` init was missing the `locateFile` override that
   `GameResImporter.ts` already needed for the same library. All fixed. A desync now
   downloads one `desync-debug.7z` (statedump + lockstep log bundled into a single file
   — two synthetic downloads back-to-back with no real user gesture is exactly what
   Chrome's multi-download blocker suppresses).

**Verification performed:** client typecheck + 240 tests, server typecheck + 208
tests, all clean. The `7z-wasm`/`locateFile` fix specifically was verified by spinning
up a throwaway Bun static server serving `public/` as root and confirming `/7zz.wasm`
resolves over real HTTP (a bare `bun run` script has no page origin, so root-relative
`fetch()` can't be tested without this). The `Game.status` and `handleActive` fixes
were verified against the user's real server logs and browser console output, not just
static analysis — multiple earlier "should be fixed now" claims in this session turned
out wrong on retest, so treat any new claim of "fixed" here as needing the same
empirical bar.

## What's NOT yet verified

- The `handleActive` (backgrounding) fix has **not** been retested by the user yet —
  the log that surfaced the bug predates the fix.
- No real desync has occurred since the `Game.status` fix, so the
  `desync-debug.7z` download path is verified structurally + via a Bun harness, but not
  via an actual live desync in the browser.
- The Chrome DevTools MCP extension was **not connected** this session
  (`tabs_context_mcp` failed with "Browser extension is not connected") — if it's
  available next time, it'll be much faster for verification than static analysis or
  Bun-based worker harnesses.

## Branch hygiene — do not lose this

The working tree currently has substantial **uncommitted, unrelated** changes sitting
on top of `feat/reconnect-resume` (they carry over regardless of branch, since
uncommitted changes aren't branch-scoped). These belong to *other* feature topics and
were deliberately left out of both commits above:

- **Alliance-lock feature** (`lockAlliances` gameopt): `src/game/action/ToggleAllianceAction.ts`,
  `src/game/gameopts/GameOpts.ts`, `src/gui/screen/game/CombatantUi.tsx`,
  `src/gui/screen/game/gameMenu/DiploScreen.ts`, `src/network/gameopt/Parser.ts`,
  `src/network/gameopt/Serializer.ts`, `src/network/lan/LanRoomSession.ts`,
  untracked `src/test/allianceFormation.test.ts`
- **Matchmaking teams**: `server/src/matchmaking/MatchmakingBot.ts`, untracked
  `server/test/matchmakingTeamAllocation.test.ts`
- **WOL lobby / region gateway**: `public/servers.ini`, `server/nginx.conf`, untracked
  `gateway/`
- **Local dev config toggle** (not a feature, just an env swap): `public/config.ini`
- **Deploy scripts** (untracked): `deploy.ps1`, `deploy.sh`

If asked to work on any of those topics, they'll need their own branch treatment the
same way this session did for reconnect — don't assume they belong on
`feat/reconnect-resume`.

## Suggested next steps

1. Ask the user for a fresh test result on the `handleActive` fix specifically
   (background one tab mid-game, confirm the player's actions keep applying after
   refocus, no more `ignoring stale turn` spam).
2. If a desync does happen to fire during testing, confirm `desync-debug.7z` actually
   downloads this time — that closes the loop on item 3 above.
3. Once confirmed, likely push `feat/reconnect-resume` and open a PR — user hasn't
   asked for this yet, confirm before doing it (git push / PR creation are
   confirm-first actions per this project's working norms).
4. The other topics (alliance-lock, matchmaking, gateway) are still sitting uncommitted
   on the same working tree — flag this to the user early in the next session so they
   don't get lost or accidentally bundled into an unrelated commit.

## Suggested skills

- **`run`** — if the next session needs to actually launch the client/server locally
  to verify a fix rather than reason about it statically.
- **`diagnosing-bugs`** — if the backgrounding fix or any new desync report needs
  another root-cause investigation loop.
- **`code-review`** — worth running before pushing `feat/reconnect-resume` /
  opening a PR, given the density of subtle bugs found by inspection this session.
- **`security-review`** — not urgent, but the new `desync-debug.7z` client-triggered
  download path is new attack surface worth a glance before it ships.

## Working norms observed this session (carry forward)

- User wants git operations (branch creation, selective commits) confirmed via
  `AskUserQuestion` before executing when there's a structural decision (branch base,
  ambiguous file inclusion) — this went well, keep doing it.
- User is testing with real playtests against a local dev server (`ws://127.0.0.1:9090`)
  and pasting raw server logs + browser console output — read these literally and
  precisely; several bugs in this session were found by tracing exact log lines rather
  than guessing.
- Global CLAUDE.md instructs "production-grade Google-level" code bar, and mentions an
  `rtk` (Rust Token Killer) bash-command proxy hook is configured — visible in the
  user's own pasted commands (`rtk grep`, `rtk sed`) but not something to invoke
  directly.
