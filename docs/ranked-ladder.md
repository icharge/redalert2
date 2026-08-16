# Ranked Ladder & Rating System

How ranked play works on this server: the ladder API, the rating model, the
match-scoring pipeline, and every validation rule that decides whether a game
counts.

## Overview

Ranked play is a thin server layer on top of the existing quick-match
machinery. The client was already ladder-aware (ladder UI, `RKD=1` ranked flag,
game-result packet builder); this document describes the server implementation
in `server/src/ladder/` and `server/src/http/routes.ts`.

```
client queue (ranked)  →  matchbot creates ranked gserv instance
       ↓                        (tagged with ladderType)
   game plays, ends
       ↓
client POSTs GameRes.toBinary() →  /wgameres/{sku}  (Bearer session token)
       ↓
server validates → scores (idempotent) → updates standings
       ↓
server pushes 730 game report to every player with an open WOL connection
       ↓
score screen shows points/MMR gain · ladder UI reflects the new standings
```

Trust model: **results are client-reported** and made safe by session auth,
instance-roster matching, cross-report agreement, a minimum duration, and
one-time game IDs (see [Validation & anti-abuse](#validation--anti-abuse)).
Server-side end-state detection is out of scope.

## Ladder API

Base URL is advertised in `servers.ini` as `wladderUrl` (dynamic
`/servers.ini` builds it from `EXTERNAL_URL`). `{sku}` is the client SKU
(16640 = Red Alert 2, 18688 = Yuri's Revenge).

| Method & path | Purpose | Response |
|---|---|---|
| `GET /ladder/{sku}` | Season slugs, newest first | `["current", "prev", …numeric ids]` |
| `GET /ladder/{sku}/{season}?locale=` | Season details | see below |
| `POST /ladder/{sku}/{ladderType}/{season}/listsearch` | Player profiles; body `{players, locale}` | array of profiles |
| `POST /ladder/{sku}/{ladderType}/{season}/rungsearch` | Paged standings; body `{ladderId, start, count}` | `{records, totalCount}` |

`{ladderType}` is `1v1` or `2v2-random`; `ladder.id` in every response equals
that string, because the client passes it straight back to `rungsearch`.
Season slugs: `current` = newest season (by `startTime`), `prev` = second
newest, otherwise the numeric season id. Unknown sku/season/ladder and ladders
with no ranked players yet return `404` (the client tolerates this and shows
an empty ladder).

`GET /ladder/{sku}/{season}` returns:

```json
{
  "name": "Season 1",
  "startTime": "…ISO 8601…",
  "endTime": "…ISO 8601…",
  "ladders": [
    { "id": "1v1", "type": "1v1", "name": "1v1" },
    { "id": "2v2-random", "type": "2v2-random", "name": "2v2 Random" }
  ],
  "totalRankedPlayers": [ { "ladderType": "1v1", "value": 12 }, { "ladderType": "2v2-random", "value": 3 } ]
}
```

`listsearch` returns one profile per requested player, in input order.
Players who have not finished placement get the placement box shape
(`{name, placementMatchesLeft}`); placed players get the full profile
(`name, rank, rankType, ladder, points, mmr, wins, losses,
placementMatchesLeft: 0, bonusPool, promotionProgress`).

`rungsearch` uses **1-based** `start` and returns only placement-complete
players (`rankType` 1–10). The client requests `count + 1` records to detect
`hasNextPage`.

## Rating model

Implementation: `server/src/ladder/rating.ts` — pure functions, no I/O.

### Elo expected score

```
E(A beats B) = 1 / (1 + 10^((ratingB − ratingA) / 400))
```

### Rating change

```
delta = K · (score − expected)      score = 1 win, 0 loss, draws unchanged
rating = round(rating + delta)
```

The K-factor depends on the player's **own** placement state, so both sides of
a match can move asymmetrically:

| State | K | Effect |
|---|---|---|
| Placement games remaining (< 10) | 60 | ratings move fast; matches are seeding |
| Placed (≥ 10 games) | 24 | normal ratings |

Both sides of a match move by the same amount in opposite directions
(`delta_winner = −delta_loser`), so the pool of rating is conserved. Elo is
self-correcting: an upset win transfers more points than a favourite's win.

### Placement

Every new player starts at `STARTING_RATING` (1000) with
`PLACEMENT_MATCHES` (10) placement games left. Until placement completes:

- the player is not in the ladder standings (their name is absent from
  `rungsearch` and `totalRankedPlayers`);
- the profile is the placement box (`N placement matches left` on the
  quick-match screen);
- wins, losses **and draws** count toward placement (draws move no rating).

### Rank thresholds

Rating (MMR) maps to a rank (`PlayerRankType` 1–10, mirrored from the
client):

| Rank | Threshold |
|---|---|
| Private | 1000 |
| Corporal | 1100 |
| Sergeant | 1200 |
| Lieutenant | 1300 |
| Major | 1400 |
| Colonel | 1500 |
| Brigadier General | 1600 |
| General | 1750 |
| Five-Star General | 1900 |
| Commander-in-Chief | 2100 |

`promotionProgress` (profile) interpolates between the current threshold and
the next: `progress = (rating − current) / (next − current)`, `demotion: true`
while rating sits below the current rank's threshold. The top rank has no
progress bar.

### Points vs MMR vs bonus pool

The client shows three related numbers:

| Field | Definition |
|---|---|
| **MMR** | the Elo rating itself (used for matching order and thresholds) |
| **Bonus pool** | streak bonus, see below |
| **Points** | `rating + bonusPool` — the headline number |

**Win-streak bonus pool:** from the **3rd consecutive win** onward, every win
adds +10 to the bonus pool; any loss resets the pool to 0. Points therefore
inflate during streaks while MMR moves only by Elo. Draws leave both
untouched.

### Standings order

Deterministic comparator: rating ↓, wins ↓, losses ↑, name ↑ (ASCII).
`rungsearch` slices this order.

## Scoring a match (POST /wgameres/{sku})

The client POSTs its `GameRes.toBinary()` packet, base64-encoded, with
`Authorization: Bearer <sessionToken>`. `server/src/ladder/gameResCodec.ts`
decodes the big-endian field map (`GMID`, `NAM*`, `CMP*`, `FINI`, `TRNY`,
`DURA`, `SHRT`, `OOSY`, …).

### Validation chain (any failure is terminal for the client's retry loop)

1. **Auth** — session token valid; `SNAM` (the reporting account in the
   packet) must equal the session's username.
2. **Packet** — decodes cleanly; `GSKU` matches the URL sku.
3. **Instance** — `GMID` matches a gserv instance that was created **ranked**
   (only the matchbot creates ranked instances), with a valid `ladderType`,
   and the game has not outlived the report window.
4. **Roster** — the report players must equal the instance's non-observer
   players exactly (case-insensitive).
5. **Game state** — `TRNY` true (ranked), `FINI` true, not out-of-sync
   (`OOSY`), not a short game (`SHRT`).
6. **Duration** — ≥ `MIN_REPORT_DURATION_SECONDS` (default 120 s, anti-farm).
7. **Outcomes** — completion statuses map to Win/Loss/Draw; `Playing` is
   rejected. For 1v1: one Win + one Loss, or both Draw. For 2v2: both
   teammates agree — two Wins + two Losses, or all four Draw. Any other
   combination (both sides win, win+draw, partial draws) rejects the **whole**
   report without scoring.
8. **Dedupe** — `ladder_matches.game_id` is a primary key; a repeated report
   is a no-op returning the original result.

### Recording

`LadderService.recordMatch` is the only scoring code path:

1. Each player's standing is loaded (or seeded at `STARTING_RATING`).
2. Winners beat the **opposing team's average rating** (for 2v2, both
   teammates gain the same delta); losers lose against the winners' average.
3. `applyOutcome` per player (rating, W/L record, placement count, streak,
   bonus pool), `applyDraw` for draws (draws count toward placement only).
4. Standings are upserted (`username_key, season_id, ladder_type` PK) and a
   `ladder_matches` audit row is written with the result payload.
5. The result payload is returned for broadcast.

### 730 game report push

For every report player with an active WOL connection (nick = account name),
the server sends:

```
:server 730 <nick> :<base64(JSON)>
```

```json
{
  "gameId": "g1-m8t7p4x2",
  "duration": 312,
  "players": [
    { "name": "alice", "resultType": 0, "rankType": 3,
      "points": { "value": 1105, "gain": 22 },
      "mmr":     { "value": 1032, "gain": 12 } }
  ]
}
```

`resultType`: 0 Win, 1 Loss, 2 Draw. The score screen's MMR column and
points-gain line are rendered from this payload.

## Worked example

Alice (rating 1000, placing) beats Bob (rating 1000, placing) in a 1v1 that
lasted 5 minutes.

```
E(Alice) = 1 / (1 + 10^((1000−1000)/400)) = 0.5
Alice:  +60 · (1 − 0.5) = +30   → 1030, placement 1/10, points 1030
Bob:    −60 · 0.5       = −30   →  970, placement 1/10
```

Later, both placed: Alice at 1100, Bob at 1000.

```
E(Alice) = 1 / (1 + 10^((1000−1100)/400)) ≈ 0.64
Alice:  +24 · 0.36 ≈ +8.6 → 1109
Bob:    −24 · 0.64 ≈ −15.4 →  985
```

The favourite gains less than the underdog loses — that asymmetry is what
pulls ratings toward their true skill level. After her third consecutive win,
Alice's bonus pool is +10, so her points read `1109 + 10 = 1119` while her MMR
stays 1109; one loss resets the pool to 0.

## What does NOT score

- unranked queue games, custom games, and any game whose instance was not
  created ranked;
- games shorter than the minimum duration;
- desyncs (`OOSY`), short games (`SHRT`), quits and disconnects before
  `FINI`;
- conflicting reports (e.g. both sides claim victory) — the whole report is
  rejected;
- reports for game IDs that never existed, were never ranked, or whose report
  window (10 minutes, `GSERV_REPORT_WINDOW_SECONDS`) has closed — a game ID
  can be reported exactly once, ever.

## Ranked version gate

Ranked queue entries must match the server's `GAME_VERSION` on
`major.minor.patch` exactly (the git-hash build suffix is ignored:
`0.83.4-abc123` == `0.83.4`). Unranked queues only require `major.minor`.
This keeps both sides of a ranked game on identical game logic.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `GAME_VERSION` | `0.83.4` | advertised version; ranked queues require exact patch |
| `STARTING_RATING` | `1000` | initial rating |
| `PLACEMENT_MATCHES` | `10` | games before a player is ranked |
| `MIN_REPORT_DURATION_SECONDS` | `120` | minimum reportable game length |
| `GSERV_REPORT_WINDOW_SECONDS` | `600` | how long ended instances keep their metadata for validation |

## Match archive & replays

`ladder_matches` doubles as the match archive for **every** finished game:

- **Public/custom games** are archived when the gserv instance finalizes
  (`scored = 0`, `ladder_type = ""`), with the recorded replay file name.
- **Ranked games** upgrade the same row in place when the game-res report
  arrives (`scored = 1`, ladder type + payload) — the gameId stays the dedupe.
- On boot, `backfillReplayPaths` links existing `.rpl` files in
  `REPLAYS_DIR` to their rows, so pre-upgrade history stays browsable.

Replay files are written by the server when `RECORD_REPLAYS=true` (default
off) as `REPLAYS_DIR/game-<gameId> <ISO timestamp>.rpl` and are importable in
the client's Replays screen. Admin API:
`GET /admin/replays` (list + file sizes) and
`GET /admin/replays/{gameId}` (download the `.rpl`).

**Direct playback deeplink**: the client route `#/replay/<base64url>` (payload
`JSON {url, name?}`) fetches a server `.rpl` from the public
`GET /replays/{gameId}` endpoint and jumps straight into the replay player —
no manual download/import. The admin console's Replays tab offers a "Watch"
button that opens this link (game URL + replay API URL are configurable
there). The client gates the replay on the engine version and only enforces
the mod hash when the client itself runs a mod (server replays record `"0"`
as the unmodded sentinel).

## Season rotation (ops)

Seasons live in `ladder_seasons` (`id, name, sku, start_time, end_time,
status`). The **newest season by `start_time` is `current`**; `prev` is the
second newest. Rotating is a manual step: insert a new row with a later
`start_time` (and optionally close the old one), e.g.:

```sql
INSERT INTO ladder_seasons (id, name, sku, start_time, end_time, status)
VALUES (2, 'Season 2', 16640, strftime('%s','now') * 1000,
        strftime('%s','now','+1 year') * 1000, 'current');
UPDATE ladder_seasons SET status = 'closed' WHERE id = 1;
```

Standings are per season (`season_id` on every row), so past seasons remain
queryable through the `prev`/numeric slugs.
