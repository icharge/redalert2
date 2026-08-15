# Server Hardening: Performance & Security

Status: DONE (implemented + verified; NOT committed — awaiting user go-ahead)
Verified: `bunx tsc --noEmit -p server`, `bun test server` (79 pass),
`wol-gserv-test` PASS, `wol-two-player` PASS against the local server.

Source of findings: performance/security review of `server/src` (Aug 2026).
Goal: fix the findings WITHOUT changing game behavior or performance for
legitimate players. Every limit below is set well above what the RA2Web client
actually sends (verified against client code) and only kicks in for abusive
input.

## Verified client baselines (why the limits are safe)

| Client behavior | Evidence |
| --- | --- |
| Usernames match `^[A-Za-z0-9-_]+$` | `src/gui/screen/mainMenu/login/LoginScreen.ts:121`, `NewAccountScreen.ts:84` |
| Nick/chan parsing regexes: nick `[A-Za-z0-9-_]`, chan `[A-Za-z0-9-_#']` | `src/network/WolConnection.ts:274,795,960`, `GservConnection.ts:274` |
| Client PONGs server PINGs (so ping-timeout reaping is safe) | `src/network/WolConnection.ts:165` |
| Channel keys on the wire are escaped (space `_`, `:` `%=`, `,` `%-`, newline `%n`) so escaped keys are always `[A-Za-z0-9#%_'-]` | `server/src/protocol/lineCodec.ts` |
| Network turn = `GSERV_NET_RATE_MS` (33ms) -> at most ~30 gserv binary frames/sec/player | `src/network/gamestate/LockstepManager.ts`, `server/src/gserv/replay/gameoptCodec.ts` |
| Chat/commands are single lines, no CR/LF inside a line | `src/network/IrcConnection.ts` line split |

## Task 1 — Input validation (IRL line injection)  [HIGH]

**Problem:** usernames are length-checked only (`accountStore.ts:17-26`) and
later interpolated into server lines via `userPrefix(user.nick, ...)`
(`WolServer.ts:422/447/472/562/...`). A nick containing `\r\n`, `:` or spaces
lets an attacker forge arbitrary IRC lines to every member of a channel/game.
Same class of issue for channel keys and PRIVMSG targets. Client parsers only
understand `[A-Za-z0-9-_]` nicks and `[A-Za-z0-9-_#']` channels anyway, so any
other character is already broken input.

**Fix (server/src/protocol/validate.ts, new):**
- `isValidNickChars(nick)` = `/^[A-Za-z0-9_-]+$/` (charset only; length stays
  config-driven in `AccountStore`).
- `isValidChannelKey(key)` = `/^[A-Za-z0-9#%_'-]{1,64}$/` (the escaped-key set).
- `stripCrlf(text)` = remove `\r`/`\n` (used for trailing text, which is safe
  otherwise since it sits after the final `:`).

**Enforcement points:**
- `AccountStore.register` — reject non-charset usernames (`bad_username`).
- `WolServer.handleSession` — re-check charset of the nick from the session
  token (defense in depth for pre-existing accounts).
- `WolServer.handleJoin` / `createGame` / `joinGame` — validate channel key.
- `WolServer.handlePrivmsg` — validate channel keys and nick targets; `stripCrlf` text.
- `WolServer.handleKick` — validate key + target nicks.
- `WolServer.handleTopic` / `handleGameOpt` / `handleMode` — `stripCrlf` trailing text.
- `WolServer.handleStartg` — validate player nicks.
- `WolServer.handleLine` — strip stray `\r` from each line.
- `GservServer.handleLine` — same stray-`\r` strip; `handlePrivmsg` — `stripCrlf` text.
- `WolServer.handleGping` — cap `game.pings` map size (128).

**Behavior impact:** none — legitimate clients never send anything outside
these sets.

## Task 2 — Frame/line limits + per-connection rate limits  [HIGH]

**Problem:** no `maxPayloadLength` (Bun default 64 MB), no line-count cap per
frame, no per-connection command rate limit -> memory/bandwidth/CPU DoS.

**Fix:**
- `index.ts` Bun.serve: `maxPayloadLength: config.maxPayloadBytes`
  (256 KB default, env `MAX_PAYLOAD_BYTES`). Game action frames are tiny; 256 KB
  is far above any legit frame.
- `WolServer.handleMessage`: cap lines per frame at 32 and per-line length at
  16 KB (drop excess).
- `GservServer.handleMessage`: same 32-line cap for text; binary frames are
  already capped by `maxPayloadLength`, plus a per-frame payload cap in
  `handleBinary` (64 KB).
- NEW `server/src/util/rateLimit.ts` — token bucket + fixed-window limiter.
- Per-connection buckets:
  - WOL text: capacity 120, refill 40/s (`ServerUser.wolBucket`). Legit client
    chat is ~1-2 msg/s.
  - GSERV (text + binary share one bucket): capacity 300, refill 100/s
    (`GservClient.bucket`). Gameplay is ~30 frames/s.
  - Over limit -> warn + close the connection (server drops the abusive client;
    for gserv the existing disconnect path NO_ACTION-fills pending turns).
- HTTP `/login` and `/register`: fixed-window per-IP limit keyed on
  `remoteOf(req)` (X-Forwarded-For, set by nginx). Defaults:
  `LOGIN_MAX_PER_MIN=30`, `REGISTER_MAX_PER_HOUR=20` (configurable).

**Behavior impact:** none at these rates; only sustained abuse trips it.

## Task 3 — gserv state lifetime + turn window  [HIGH]

**Problem:** `GservManager.tickets`/`instances` never expire; completed or
abandoned games leak forever (`GservManager.ts:24-65`). `state.pending` keys on
an untrusted uint32 `turnNo` (GservServer.ts:327-334) -> unbounded pending map;
`flushPendingTurns` sorts all keys per message (quadratic under flood).

**Fix:**
- `GservManager`:
  - `deleteInstance(gameId)` — removes instance + its tickets (ticket entries
    whose `info.gameId` matches).
  - `consumeTicketByNick(nick)` — remove the ticket for a player who joined
    (ticket needed only for the gserv login; after `join` it is spent).
  - `sweepExpired(ttlSeconds)` — delete un-started instances older than
    `GSERV_INSTANCE_TTL_SECONDS` (default 600) + their tickets.
- `GservServer`:
  - `handleJoin` success -> `consumeTicketByNick(client.nick)`.
  - `checkAllLoaded` (game start) -> delete all remaining tickets of the instance.
  - `finalizeInstance` (game over) -> `manager.deleteInstance(gameId)`.
  - New interval (30 s) calling `manager.sweepExpired` + `dispose()` on shutdown.
  - `handleBinary`: reject frames when `turnNo > state.lastTurnNo + 8` or
    `turnNo <= state.lastTurnNo` (already relayed), and refuse to grow
    `state.pending` beyond 16 entries. Clients submit sequentially after relay,
    so a +8 window is generous; this bounds memory to a small constant.

**Behavior impact:** none — sequential turn submission stays far inside the window.

## Task 4 — Reap dead connections (ping timeout)  [MEDIUM]

**Problem:** `pingAll` tracks `lastPongAt` but nothing disconnects clients that
stop responding (zombie sockets accumulate).

**Fix:** in `WolServer.pingAll`, close users that (a) have received at least one
PING (`lastPingSent > 0`), and (b) have no PONG for 3 ping intervals (~90 s).
Client PONGs verified (`WolConnection.ts:165`).

**Behavior impact:** none for live clients; a client on a stalled tab may be
disconnected after ~90 s instead of hanging forever.

## Task 5 — Bans and logout  [MEDIUM]

**Problem:** `handleSession` never checks `account.banned` (a user banned after
logging in keeps working tokens until TTL); `SessionManager.revoke` is never
called; `/auth/logout` (routes.ts:101) is a no-op.

**Fix:**
- `WolServer.handleSession`: if the session's account is banned -> revoke the
  token and reject with `RPL_BAD_SESSION`.
- `/auth/logout`: accept optional JSON body `{ sessionToken }` and revoke it
  (204 either way; the upstream realm flow posts without a token and stays a
  no-op, unchanged).

**Behavior impact:** none for legitimate users.

## Task 6 — Shutdown hygiene + SQLite  [LOW]

**Fix:**
- `db.ts`: `PRAGMA synchronous = NORMAL` (WAL already enabled; NORMAL avoids the
  per-commit fsync stall; same durability as WAL+NORMAL: only the last commit
  may be lost on OS crash).
- NEW `WolServer.dispose()` / `GservServer.dispose()` / `MatchmakingBot.dispose()`
  (clears `timers`).
- `index.ts`: `SIGINT`/`SIGTERM` handler -> dispose all, `server.stop()`,
  `storage.close()`, exit.

**Behavior impact:** none.

## Task 7 — Tests + verification

- New tests: `server/test/validate.test.ts` (charset/CRLF rules),
  `server/test/rateLimit.test.ts` (bucket/window semantics),
  `server/test/gservLifecycle.test.ts` (turn window, ticket consumption,
  instance deletion on finalize, TTL sweep), plus auth register charset test.
- Update existing tests if behavior changed (register charset, session ban).
- `bunx tsc --noEmit -p server`, `bun test server`, then local smoke tests
  (`wol-gserv-test.ts`, `wol-two-player.ts`) to prove gameplay is unaffected.
- Update `.env.example` with the new env knobs.

**Out of scope (noted, not done):** `/health` counts disclosure (useful for
ops), username enumeration timing (acceptable for a game lobby), CORS `*`
default (prod already overrides), nginx `client_max_body_size` (Bun now caps
payloads itself), replay `writeFileSync` (runs once at game end).

## Files touched

- new: `server/src/protocol/validate.ts`, `server/src/util/rateLimit.ts`,
  `server/test/validate.test.ts`, `server/test/rateLimit.test.ts`,
  `server/test/gservLifecycle.test.ts`
- edit: `server/src/index.ts`, `server/src/config.ts`, `server/src/auth/db.ts`,
  `server/src/auth/accountStore.ts`, `server/src/server/WolServer.ts`,
  `server/src/server/ServerUser.ts`, `server/src/gserv/GservServer.ts`,
  `server/src/gserv/GservManager.ts`, `server/src/matchmaking/MatchmakingBot.ts`,
  `server/src/http/routes.ts`, `server/test/auth.test.ts`, `server/.env.example`
