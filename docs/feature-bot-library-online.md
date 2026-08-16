# Feature: Centralized Bot Library for Online Play

Status: **proposed** (implementation plan only — no code changes yet)

## 1. Goal

Let players browse a **centralized collection of third-party AI bots** hosted by the
port's own server, install them locally, assign them to AI slots in **online** lobbies,
and have **every client in the match download the exact same bot source** before game
start so lockstep stays deterministic.

Skirmish and LAN also benefit (same library panel, same install path), but online is
the motivating case.

### Non-goals

- Not a general mod distribution system.
- No bot authoring/moderation UI (admin can publish via API; a curation page is a
  follow-up).
- No cross-version bot compatibility guarantees: a bot is pinned by
  `(botId, version, sha256)`.
- LAN/online wire compatibility with upstream clients is **not** required (bot
  feature is port-only); the wire change must still degrade gracefully in the
  session UI if a peer is an old build.

## 2. Current state (what already exists)

| Piece | Location | Status |
|---|---|---|
| Bot zip upload + validation (`BotSandbox` strip/validate) | `src/game/ai/thirdpartbot/BotSandbox.ts`, `BotUploader.ts` | Done |
| Local registry persisted to localStorage | `src/game/ai/thirdpartbot/BotRegistry.ts` (`StorageKey.UploadedBots`) | Done |
| Bot execution adapter | `src/game/ai/thirdpartbot/ThirdPartyBotAdapter.ts` | Done |
| AI slot -> bot resolution at game creation | `src/game/bot/BotFactory.ts:27-41` | Done (has unsafe fallback) |
| Skirmish upload/list/delete UI | `src/gui/screen/mainMenu/lobby/SkirmishScreen.ts:391-462` | Done |
| LAN/skirmish slot picker (`Custom:<id>`) | `src/gui/screen/mainMenu/lobby/PregameController.ts:313-320` | Done |
| `customBotId` on `SlotInfo` and `GameOpts.aiPlayers[]` | `src/network/gameopt/SlotInfo.ts:12`, `src/game/gameopts/GameOpts.ts:21` | Field exists; **serializers drop it** |
| Online lobby slot model | `src/gui/screen/mainMenu/lobby/LobbyScreen.ts` | No bot support |
| Map transfer (HTTP PUT/GET + auth + retry) | `src/network/MapTransferService.ts` | Done — reuse pattern |
| Port's own server (routes, storage, auth, rate limit) | `server/src/http/routes.ts`, `server/src/storage/{SqliteStorage,MemoryStorage,Storage}.ts` | Done |
| Loading-screen pre-game sync (maps) | `src/gui/screen/game/GameScreen.ts` (lan/map sync), `src/network/MapTransferService.ts` | Done — reuse pattern |

## 3. Architecture

```
                        +----------------------+
                        |  Port server (own)   |
                        |  /bots (JSON list)   |
                        |  /bots/<id>/<v>.zip  |
                        |  /bots (PUT publish) |
                        +----------+-----------+
                                   ^  HTTPS + session auth
        browser A (host)           |              browser B (guest)
  +--------------------------+     |     +--------------------------+
  | LobbyScreen (online)     |     |     | LobbyScreen (online)     |
  |  Bot Library panel ----->+-----+-----+--> install -> BotRegistry |
  |  assign Custom:<id> slot |           |                          |
  | gameOpts.aiPlayers[i]    |  WebRTC mesh (SlotInfo + gameOpts,   |
  |  .customBotId = id       +----+------+ customBotId included)    |
  +--------------------------+    |      +--------------------------+
                                  |  loading screen pre-game sync
                                  v
                    BotFactory.create(player) -> ThirdPartyBotAdapter
                    (identical source bytes on every client: sha256 check)
```

Determinism rule: a custom-bot match may only start when **every** client has the bot
registered with the **same** `(botId, version, sha256)`. Any client that fails
download/validation reports "bot not ready" and the host aborts with a clear error —
never a silent fallback.

## 4. Server side

### 4.1 Data model

`BotMetadata` (stored JSON, one row per bot version):

```ts
interface BotMetadata {
    botId: string;            // stable id (uuid) — versions share this
    displayName: string;
    version: string;          // e.g. "1.0.3"
    author: string;
    description?: string;
    sha256: string;           // of the zip
    zipSize: number;
    publishedAt: number;      // epoch ms
    publishedBy: string;      // account name
}
```

Storage: new `BotStore` behind the existing `Storage` abstraction
(`server/src/storage/Storage.ts`), implemented in `SqliteStorage` (table
`bot_versions`, unique on `(botId, version)`; index on `publishedAt` for newest
first) and `MemoryStorage` for tests. Zip bytes stored on disk under
`server/data/bots/<botId>/<version>.zip`.

### 4.2 Endpoints (wired into `server/src/http/routes.ts` `handleHttp`)

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/bots` | session | List newest version per botId (metadata only), newest first, paginated (`?offset&limit`), cache-friendly (`ETag`/`Last-Modified`) |
| GET | `/bots/<botId>/<version>` | session | Single metadata record incl. `sha256`, `zipSize` |
| GET | `/bots/<botId>/<version>.zip` | session | Zip bytes (`application/octet-stream`); `Content-Length` + `ETag` = sha256 |
| PUT | `/bots` | session | Publish: multipart body (metadata JSON + zip). Server-side validation (see 4.3). Returns created `BotMetadata`. Admin flag optional at first (config `bots.publishRequiresAdmin`) |

Rate limiting: reuse `FixedWindowLimiter` pattern (per-IP publish limits, e.g.
`botsPublishPerHour`); a naive download rate limit to protect the disk.

### 4.3 Server-side validation (publish path)

Same security pipeline as client `BotUploader`/`BotSandbox`, run server-side:

1. Zip checks: extension allow-list (`.ts/.json/.txt/.md/.yml`), path traversal
   (`..`, absolute), per-file ≤ 512 KB, total ≤ 10 MB, ≤ 200 files.
2. Extract `main.ts`; run `validateSource` forbidden-pattern scan
   (port the constant array to server, or share via a small shared module).
3. Reject bots whose `export` lacks `id`/`createBot`.
4. Compute `sha256` of the zip; reject duplicate `(sha256)`.
5. Store metadata + bytes; `publishedAt = now`, `publishedBy = session.account`.

## 5. Client side

### 5.1 Wire protocol — carry `customBotId` (shared LAN + online)

`src/network/gameopt/Serializer.ts`:

- `serializeAiOpts(aiPlayers)`: append a 6th field `customBotId` (empty when
  absent): `` `${difficulty},${countryId},${colorId},${startPos},${teamId},${customBotId ?? ''}` ``.
- `parseAiOpts`: read the 6th field (parts length ≥ 6; tolerate missing).

`src/network/gameopt/Serializer.ts` `serializeSlotData`:

- AI slot currently emits `@EasyAI@`. Change to `@AI@:<difficulty>,<customBotId>@`
  with a parser fallback: a slot string that still starts with `@EasyAI@` (old
  build) keeps current behavior. (Alternative that avoids touching the slot
  string: keep `@EasyAI@` and rely only on `gameOpts.aiPlayers`; pick the slot
  encoding only if guest UI needs the bot name before gameOpts arrives — decide
  in implementation.)

`src/network/lan/LanRoomSession.ts` `cloneAiPlayer` (line ~171): add
`customBotId: ai.customBotId`.

Compat rule: a port client receiving `customBotId` for a slot it cannot run
(no bot, download failed) reports "bot not ready"; old-build peers simply show
`@EasyAI@` style slots — the custom-bot match is blocked at start if any peer
can't sync, so there is no desync window.

### 5.2 Bot library UI (shared component)

New component `src/gui/screen/mainMenu/component/BotLibraryPanel.tsx` (or JSX
component matching repo conventions), used by `LobbyScreen` (online) and
`SkirmishScreen`:

- Fetch `GET /bots` via a new `BotLibraryService` (`src/network/BotLibraryService.ts`,
  modeled on `MapTransferService`: `list()`, `downloadZip(botId, version)`, auth
  header from WOL session; same retry/`DownloadError` handling).
- Rows: displayName, author, version, description, size, "Install" / "Update"
  (compare installed `(botId, version, sha256)` from `BotRegistry`).
- Install flow: download zip → `BotUploader.processUpload(zip)` (existing
  validation + registration + persist) → refresh installed list.
- Error states: network, invalid bot, disk quota of localStorage
  (`localStorage` 5 MB cap — keep zip out of storage; store only stripped
  source text like uploads today; warn when close to quota).
- Loading state + empty state ("No bots published yet").

### 5.3 Online lobby assignment

`src/gui/screen/mainMenu/lobby/LobbyScreen.ts`:

- `availableAiNames`: append installed bots as `Custom:<botId>` (same scheme as
  `PregameController.buildAvailableAiNames`), only when `botsEnabled`.
- Slot change to AI: set `customBotId` on `gameOpts.aiPlayers[slotIndex]`
  (currently missing, line ~1276) and on the outgoing `SlotInfo`.
- Keep "Custom" (no id) as-is for backward compat: unresolved → existing fallback.

### 5.4 Pre-game bot sync (determinism gate)

In the online start path (`GameScreen` — alongside the existing map sync / loading
progress), add a bot-sync phase:

1. Before `startGameHandler`, collect `(customBotId, version)` for every AI slot
   from the **host-authoritative** `gameOpts` (guests already have it once
   serialization is fixed).
2. For each local client: if not registered or hash mismatch →
   `BotLibraryService.downloadZip` → `BotUploader.processUpload` → register.
3. Report `botsReady` (count) along the existing load-percent path
   (`GservConnection`/`sendLoadedPercent` or the room `state-sync` for LAN).
4. Host waits for all peers `botsReady`; on failure (network / validation /
   timeout) abort start with `TS:BotSyncFailed` message listing the missing bot.
5. Only then `startGameHandler()` (single-player/LAN paths unchanged; LAN can
   reuse the same phase since `LanRoomSession` already has per-peer state sync).

Also in the loading screen API: surface bot download progress per bot
(`BotLoadingStatus` in `LoadingScreenApiFactory`).

### 5.5 Harden `BotFactory` fallback

`src/game/bot/BotFactory.ts:33-41`:

- If `player.customBotId` is set and the registry lookup fails, **throw** a
  descriptive error (with bot id) instead of substituting `uploadedBots[0]`.
  The substitution becomes only reachable when difficulty is `Custom` with no id
  (legacy skirmish slots).
- This is safe only after 5.4 guarantees presence; do 5.5 in the same release.

## 6. Task breakdown

Ordered (dependencies). Sizes: S ≤ 0.5 d, M ≤ 1 d, L ≤ 2 d.

| # | Task | Size | Depends on | Files | Acceptance criteria |
|---|---|---|---|---|---|
| B1 | Server: `BotStore` (metadata + zip storage) behind `Storage` interface; sqlite table `bot_versions`; memory impl | M | — | `server/src/storage/*`, `server/src/bots/BotStore.ts` | Unit tests: insert/list-by-newest, version dedupe, sha256 duplicate rejection |
| B2 | Server: publish validation (zip limits, `BotSandbox` pattern ported/shared, `sha256`) | M | B1 | `server/src/bots/publish.ts` | Rejects traversal/oversize/forbidden patterns; happy path stores metadata + zip |
| B3 | Server: HTTP routes `GET /bots`, `GET /bots/<id>/<v>`, `GET ...zip`, `PUT /bots` with auth + rate limits | M | B1, B2 | `server/src/http/routes.ts`, `server/src/config.ts` | curl end-to-end: publish → list → download; 401 without session; 429 on burst |
| B4 | Client: `BotLibraryService` (list/download with auth, retries, `DownloadError`) | S | B3 | `src/network/BotLibraryService.ts` | Mocks tests for list + zip download; auth header present |
| B5 | Client: serialize/parse `customBotId` (aiOpts 6th field, slot encoding, `cloneAiPlayer`) | M | — | `src/network/gameopt/Serializer.ts`, `Parser.ts`, `src/network/lan/LanRoomSession.ts` | Round-trip tests with and without id; old-format parse still passes |
| B6 | Client: `BotLibraryPanel` component (list/install/update/errors) | L | B4 | `src/gui/screen/mainMenu/component/BotLibraryPanel.tsx` | Manual: install from server, update on new version, error banners |
| B7 | Online lobby: list installed bots in `availableAiNames`; set `customBotId` on AI slots (gameOpts + SlotInfo) | M | B5, B6 | `src/gui/screen/mainMenu/lobby/LobbyScreen.ts` | Host assigns `Custom:<id>`; guest sees slot; serialized opts carry id |
| B8 | Pre-game bot sync phase + loading screen progress + abort on failure | L | B5, B7 | `src/gui/screen/game/GameScreen.ts`, `loadingScreen/*`, `src/gui/screen/mainMenu/lobby/LobbyScreen.ts` | Two-browser test: guest without bot auto-downloads; missing download aborts with clear message; no desync |
| B9 | Skirmish: add BotLibraryPanel + installed list integration | S | B6 | `src/gui/screen/mainMenu/lobby/SkirmishScreen.ts` | Skirmish screen shows library; installed bots usable as before |
| B10 | Harden `BotFactory` fallback (throw when id set but missing) | S | B8 | `src/game/bot/BotFactory.ts` | Custom-bot game with missing local bot fails fast with clear error |
| B11 | E2E: seed server with a test bot, publish via `PUT`, run a 2-browser online match with the bot | M | B3-B10 | `server/test/*`, `docs` | Match starts only after both clients sync; replay shows bot actions |
| B12 | Docs: user-facing README section (publish + install + play) and `server/README.md` endpoints table | S | B11 | `README.md`, `server/README.md` | — |

## 7. Failure modes & policy

| Failure | Behavior |
|---|---|
| Bot not installed on a client | Auto-download in pre-game sync |
| Download fails (network/server down) | Retry (MapTransferService pattern, 6x); then abort with `TS:BotSyncFailed` naming the bot — never start |
| Validation fails on download | Abort start with reason; bot marked "invalid" in library UI |
| Zip/source size > localStorage quota | Store only stripped source (as today); warn; block install with message |
| Old build peer in room | Its slots simply lack bot info; it joins as `@EasyAI@`; if host pins a custom bot, sync blocks until it leaves or upgrade |
| Host publishes while unauthenticated | 401 |
| Duplicate publish (same sha256) | 409 with existing metadata |
| BotFactory sees id without registry entry (should be unreachable after B8) | Hard error (B10) — catches future regressions |

## 8. Testing plan

- **Unit**: BotStore (B1), publish validation (B2), serializer round-trips incl.
  old format (B5), BotLibraryService with mocked fetch (B4), BotFactory fallback
  (B10).
- **Server integration** (`server/test`): HTTP routes against MemoryStorage + real
  session; rate-limit windows.
- **E2E manual**: 2 browsers, one with bot installed, one without → sync downloads
  on the clean client; kill server mid-download → clean abort; 3-client room with
  a guest on old build → blocked start message.
- **Regression**: existing skirmish upload/play (B9 must not alter it); LAN custom
  bot flow still works (B5/B8 reuse).

## 9. Rollout order

1. B1-B3 (server publishes + serves) — independently shippable.
2. B4-B6 (client library browse/install) — usable for skirmish/LAN immediately.
3. B5 + B7 + B8 + B10 (online assignment + determinism gate) — the online release.
4. B9, B11, B12 — polish + verification.
