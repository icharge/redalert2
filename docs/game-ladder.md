# Game Ladder (ranked play) — implementation plan

Branch: `feat/wol-lobby-server` · Repo: ra2web

## Architecture

- **Ladder = REST service** on the existing Bun server, implementing the exact `WLadderService` contract:
  - `GET /ladder/{sku}` — seasons list
  - `GET /ladder/{sku}/{season}?locale=` — season details
  - `POST /ladder/{sku}/{ladderType}/{season}/listsearch` — player profiles (`{players, locale}`)
  - `POST /ladder/{sku}/{ladderType}/{season}/rungsearch` — paged standings (`{ladderId, start, count}`)
- **Results = client-reported** via the existing `WGameResService` machinery:
  - `GameScreen.sendGameRes` (currently a `console.log` stub, `src/gui/screen/game/GameScreen.ts:1484`) builds the `GameRes.toBinary()` packet (`src/network/gameres/GameRes.ts:335`) and POSTs it to `/wgameres/{sku}` with `Bearer <sessionToken>`.
  - Server validates, updates standings, then pushes `RPL_GAME_REPORT` (730) to every report player. Client already dispatches 730 (`src/network/WolConnection.ts:218-219`) and `ScoreScreen` polls `wolService.getLastGameReport()` to render points-gain / MMR columns.
- **Ranked flag already flows**: client sends `RKD=1` in ranked queues (`QuickGameScreen.ts:835`), matchbot stores it (`server/src/matchmaking/MatchmakingBot.ts:133,153`) but drops it — only `gameopts`/`GameChannel` are passed on.

Client side is essentially complete (UI + REST consumers + locale strings exist in en-US and zh-CN); the work is mostly server-side plus re-wiring the stubbed client plumbing.

## Phase 1 — Server data model + rating engine

1. Extend `Storage` (`server/src/storage/Storage.ts:21`) + `SqliteStorage` + `MemoryStorage` with:
   - `ladder_seasons(id, name, sku, start_time, end_time, status)` — bootstrap a "current" season on init.
   - `ladder_standings(username_key, season_id, ladder_type, rating, wins, losses, draws, placement_games, win_streak, bonus_pool, last_game_at)` — PK `(username_key, season_id, ladder_type)`.
   - `ladder_matches(game_id, ...)` — dedupe/audit.
2. New `server/src/ladder/rating.ts` (pure functions):
   - `STARTING_RATING = 1000`, `PLACEMENT_MATCHES = 10`, Elo-ish K-factors (provisional vs regular), win-streak bonus pool, rank thresholds mapping rating → client `PlayerRankType` (1..10; constants in one file).
   - Deterministic standings comparator (rating desc, wins desc, name).
3. New `server/src/ladder/LadderService.ts`:
   - `recordMatch(gameId, ...)` — idempotent update.
   - `getSeasons`, `getSeason` → `{name, startTime, endTime, ladders: [{id: "1v1" | "2v2-random", type, name, divisionName}], totalRankedPlayers}`. Note `ladder.id` must equal the `LadderType` string — the client passes it straight back to `rungsearch`.
   - `listSearch` → profiles `{name, rank, rankType, ladder, points, mmr, wins, losses, placementMatchesLeft, provisionalMmr, bonusPool, promotionProgress}`; unranked player → `{name, placementMatchesLeft}` (renders the placement box, `QuickGameForm.tsx:100-103`).
   - `rungSearch` → `{records: [{name, rank, points, mmr, wins, losses, draws, rankType}], totalCount}` (1-based `start`; client fetches `count+1` to detect `hasNextPage`).

## Phase 2 — Server HTTP endpoints (`server/src/http/routes.ts`)

- The four ladder routes above; return 404 when a ladder has no standings yet (client tolerates it, `LadderScreen.ts:113-117`).
- Generate `wladderUrl={baseUrl}/ladder` + `wgameresUrl={baseUrl}/wgameres` in the dynamic `/servers.ini` (`routes.ts:79-91`); also update the static `server/servers.ini` and `server/.env.example` (`STARTING_RATING`, `PLACEMENT_MATCHES` optional env overrides).

## Phase 3 — Server result reporting

1. Tag gserv instances at creation with `ranked` + `ladderType`:
   - `MatchmakingBot`: queue `channelType` 50/60 → `1v1`, 51/61 → `2v2-random`, set from `QueueEntry.ranked`.
   - Custom games: never ranked.
   - Also fix the `GservManager.instances` leak (map never cleaned, `server/src/gserv/GservManager.ts`) — delete on `finalizeInstance` or TTL so old gameIds cannot be re-reported.
2. New `server/src/ladder/gameResCodec.ts`: decode the client's `GameRes.toBinary()` field map (GMID, NAM*, CMP*, FINI, TRNY, DURA, SHRT, OOSY, VERS, ...), reusing `DataStream` from `server/src/gserv/replay/gameoptCodec.ts`.
3. `POST /wgameres/{sku}`:
   - Auth via session token (`Authorization: Bearer ...`).
   - Validate: instance exists and is ranked; report players match instance players (non-observers); both opponents' reports agree (Win/Loss complementary, Draw/Draw); `finished && !outOfSync && !shortGame`; duration ≥ min (e.g. 120 s — anti-farm).
   - On success: update standings, then for each report player with an active WOL session push `:server 730 <nick> :<base64(JSON {gameId, duration, players: [{name, resultType, rankType, points: {value, gain}, mmr: {value, gain}}]})>` (matches `WolGameReport` shape + `ScoreTable` fields).
   - Lenient failure modes — 4xx is terminal for the client retry loop (`WGameResService.ts:60-62`); duplicates → no-op.
4. Verify session username ↔ in-game nick mapping in `WolServer.session` (`WolServer.ts:204-229`) so the 730 push targets the right nick.

## Phase 4 — Client wiring (small)

1. `LoginScreen.ts:606` — also call `wgameResService.setUrl(region.wgameresUrl)` next to `wladderService.setUrl`.
2. `GameScreen.sendGameRes` (`GameScreen.ts:1484`) — build `GameRes.fromGame(game, this.isTournament, this.getGameResClientInfo(result)).toBinary()` and POST via `WGameResService.sendGameResPacket` (retry/backoff built in). Pass the service into GameScreen via `MainMenuRootScreen.createScreen`.
3. Mark ranked quick-match games `tournament` end-to-end so `ScoreTable` renders the MMR column (`showReport = tournament && gameReport`, `ScoreTable.tsx:39`) — verify how `isTournament` reaches GameScreen (`GameScreen.ts:137`) and patch the route from `QuickGameScreen.handleGameStart` if needed.
4. Verify `WolService.lastGameReport` is populated from `wolCon.onGameReport`.
5. No changes to `LadderScreen` / `Ladder.tsx` / `GameBrowser` / `QuickGameForm` — they already consume the contract (locale strings exist in en-US + zh-CN).

## Phase 5 — Tests

- Server: rating unit tests (thresholds, placements, bonus pool, promotion progress, ties); standings queries on Memory + SQLite; `gameResCodec` decode of a hardcoded client-produced fixture (base64, same pattern as `src/test/ServerReplay.test.ts`); wgameres endpoint tests (auth, validation, dedupe, 730 push via fake socket); ladder routes shape assertions.
- Client: typecheck + existing suites; manual smoke for the canvas game-end flow.

## Risks / decisions

- **Trust model**: client-reported outcomes (server-authoritative end-state detection is out of scope for v1); mitigated by session auth, cross-report agreement, min duration, instance matching.
- **2v2 handling**: both teammates share the outcome; conflicting/partial-draw reports → no-score.
- **Season rotation** is a manual ops step (insert a new `ladder_seasons` row; `current` = latest).
