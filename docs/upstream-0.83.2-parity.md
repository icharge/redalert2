# Upstream 0.83.2 Parity Report

Date: 2026-08-07
Source: `ra2web.min-0.83.2.js` (official RA2WEB client bundle, `System.register` format, version `0.83.2`)
Method: beautified with `js-beautify`, split into 1253 modules with acorn AST parsing, API-surface diffed against `src/` (1266 files).

## Executive summary

This repo is a fork of RA2WEB at the same base version (0.83.2), rewritten in TypeScript, with three
fork-specific feature areas: **LAN multiplayer** (`src/network/lan/*`), **third-party bot sandbox**
(`src/game/ai/thirdpartbot/*`), and **debug/test tooling** (TestEntryScreen, SceneSandbox,
LiveInteractionTester, ...). Shared modules (engine, data, most of game logic, gui) are functionally
equivalent reimplementations.

The upstream bundle contains **97 modules absent from this repo**. They fall into three groups:

| Group | Modules | Nature |
|---|---|---|
| A. Gameplay/engine features | ~14 | Portable, no conflicts |
| B. Worker thread pool | 2 | Perf, needs `threads` dep |
| C. Online WOL multiplayer stack | ~81 | Conflicts with LAN architecture (deliberately removed in this fork) |

In addition, ~10 shared modules carry behavioral changes (state-machine rewrites, new rules fields,
new game options, new detonate() semantics).

## A. Gameplay / engine features (portable)

1. **Engineer capture cast bar**
   - New `CastProgressTrait` (`game/gameobject/trait/CastProgressTrait`) — ticks-based timer with
     progress, reset on teleport/owner-change.
   - New `UnitCastBarSprite` (`engine/renderable/entity/UnitCastBarSprite`) — canvas-based bar above
     infantry, `renderOrder` 999998, cyan fill on black backdrop.
   - `EnterBuildingTask` rewritten as a state machine: `Initial → MovingNear → WaitingForDelay →
     MovingIn → MovingOut`; when `enterDelaySeconds > 0` the unit moves next to the building
     (`MoveNextToTask`) and casts before entering. `onEnd` resets the cast trait. This new flow is
     shared by all 6 subclasses (Capture, Repair, PlantC4, EnterRecycler, Infiltrate, Garrison).
   - New `MoveNextToTask` (`game/gameobject/task/move/MoveNextToTask`) — moves next to a target
     building (close-enough `Math.SQRT2`, ignores the building as a blocker, `RangeHelper` in-tile-range).
   - `CaptureBuildingTask`: adds `static getCaptureDelaySeconds()` =
     `engineerCaptureDelay` general rule unless `multiEngineer || instantCapture || neutral ||
     needsEngineer`; capture runs through the cast bar.
   - `Infantry`: `rules.engineer` now adds `castProgressTrait`.
   - `PipOverlay`: unit branch creates `UnitCastBarSprite` (positioned from `pipbrd` image 1) and
     updates/disposes it.
   - `GeneralRules`: new field `engineerCaptureDelay` (`EngineerCaptureDelay`, default 12).

2. **Building secure-capture progress (delayed oil derricks)**
   - New `SecureProgressTrait` (`game/gameobject/trait/SecureProgressTrait`) — securing player +
     timer; on expiry `buildingsCaptured++`, `changeObjectOwner`, `BuildingCaptureEvent`; aborts on
     owner change, death, or non-neutral. `engineerTechSecureTime` (default 4) seconds.
   - New `SecureProgressSprite` (`engine/renderable/entity/SecureProgressSprite`) — 90x26 canvas bar
     with player name when hovered, shown when `alliances.haveSharedIntel(viewer, securingPlayer)`.
   - `Building`: `capturable && needsEngineer && (produceCashStartup>0 || produceCashAmount>0)` adds
     the trait.
   - `CaptureBuildingTask.onEnter`: `gameOpts.delayedOils && neutral` → start secure progress instead
     of instant capture.
   - `GameOpts`: new fields `instantCapture` (default true), `delayedOils` (default false).
   - `network/gameopt/Parser` + `Serializer`: two new option bits after `noDogEngiKills`.
   - `PipOverlay`: building branch creates/updates/disposes `SecureProgressSprite`.

3. **SpecialWarheadType**
   - New `game/SpecialWarheadType` enum: `None`, `Shrapnel`, `LightningStrike`, `TntCharge`.
   - `Warhead.detonate(..., specialWarheadType = None, ...)`: shrapnel skips friendly infantry;
     lightning strike feeds `isWeatherStorm` through damage/anim selection.
   - `TntChargeTrait` detonates with `TntCharge`; `LightningStormEffect` with `LightningStrike`.
   - Local fork replaced this param with a `friendly: boolean` flag — all ~14 local call sites pass
     `false`; will be replaced by the enum.

4. **Forced disguise (Bender of Spoons)**
   - New `ForcedDisguisePlugin` (`engine/renderable/entity/plugin/ForcedDisguisePlugin`) — disguises
     human infantry as `audioVisual.benderOfSpoons` art for non-owners; `getUiNameOverride` returns
     disguise uiName; reveals on owner view.
   - `RenderableFactory`: when `forcedYuriDisguise && benderOfSpoons && isHuman && !Fly &&
     art.hasObject(...)` uses the plugin instead of `InfantryDisguisePlugin`.
   - `AudioVisualRules`: new field `benderOfSpoons`.

5. **Bot/API additions**
   - `game/api/PlayerApi` — per-player facade over GameApi: `getPlayerData`, `isDefeated`,
     `isAlliedWith`, `canPlaceBuilding`, `getVisibleUnits`.
   - `game/api/GameApi` gains `getPlayerData`, `isPlayerDefeated`, `areAlliedPlayers`,
     `canPlaceBuilding`, `getVisibleUnits` (+ new interface types `PlaceCheckOptions`,
     `ReachabilityMap`).
   - `game/bot/BotContext` — `{ game, player, logger }` passed to bots.

6. **Type-only refactors**
   - `gui/screen/ScreenParamsMap`, `gui/screen/mainMenu/ScreenParamsMap` — screen-param type maps
     (runtime-empty).

## B. Worker thread pool (perf)

- `worker/workerHost` — `threads`-library pool (`concurrency = hardwareConcurrency - 1`) for
  `decodeWav`, `generateVxlGeometry`, `compressFile`; `workerHostApi.queueTask/waitForTasks/dispose`.
- `worker/WorkerApi` — worker-side RPC surface (built as separate `worker.min.js` bundle).
- Local `GameScreen`/`GameLoader` already accept `workerHostApi` but receive `undefined`.
- Requires: `threads` npm dependency, a second vite build entry for the worker, replacing the
  synchronous calls in `GameLoader` (building image generation), `data/WavFile.decodeWav` callers,
  and game-res compression.

## C. Online WOL multiplayer stack (absent locally)

Roughly 81 modules across 6 layers:

1. **Auth/account** (`network/authConfig`, `AuthService`, `AccountLoginFormData`,
   `AccountRegFormData`, `SessionService`, `RealmService`, `Realm`, `RealmListResponse`,
   `ServerRegions`, `CreateRealmSession*`, `ClaimNickname*`, `CreateNickname*`,
   `NicknameListResponse`, `network/Logger`) — username/password auth, realm sessions, nickname
   claim flow.
2. **Gateway/WOL transport** (`network/GservConnection`, `GservError`, `network/gservCodes`,
   `network/gservConfig`, `WolConnection`, `WolConfig`, `WolConnectOptions`, `WolError`,
   `WolGameReport`, `WolGameStartAbortReason`, `WolLocale`, `WolService`, `network/wolCodes`,
   `WolGameTopic`) — WOL protocol client (pre-game lobby, in-game channel, match reporting).
3. **IRC chat** (`network/IrcConnection`, `IrcProtocol`, `network/chat/Message`,
   `network/chat/SystemMessage`) — IRC-style chat protocol.
4. **Game res / map transfer** (`network/MapTransferService`, `WGameResService`,
   `network/gameres/GameRes*` 5 modules + `wgameResConfig`, `gameopt/PingInfo`) — P2P asset sync.
5. **Lockstep** (`network/gamestate/ActionSerializer`, `LockstepManager`,
   `PlayerActionPayload`, `PlayerConnectionInfo`, `PlayerConnectionStatus`, `lockstepUtil`,
   `ReplayEvent` + factory/type + `TurnActionsReplayEvent`) — deterministic networking
   (fork's LAN re-implements this area; upstream versions differ).
6. **Matchmaking/lobby UI** (`gui/screen/mainMenu/login/*` 8 modules, `nicknameSelection/*` 3,
   `realmSelection/*` 2, `quickGame/*` 2, `customGame/component/viewmodel/gameBrowser`,
   `gui/component/PartyInviteDialog`, `SendPartyInviteDialog`, `PlayerContextMenu`,
   `CfTurnstileWidget`, `gui/CfPreclearanceApi`, `util/CfTurnstile`, `ladder/PlayerMatchHistoryEntry`,
   `xwol/*` 3, `partyCodes`, `qmCodes`).

Porting group C means rewiring `Gui.ts`/`Application.ts`/`RootController` to upstream shape
(upstream `Gui` imports ~100 modules incl. all online screens and services). The fork's LAN screens
and login flow must coexist.

## Shared-module behavioral deltas (all confirmed above)

- `Warhead.detonate` — `friendly` param → `specialWarheadType` enum.
- `EnterBuildingTask` — state machine + delay + cast bar (all 6 subclasses inherit).
- `CaptureBuildingTask` — delay seconds + secure-progress path.
- `GeneralRules` — `engineerCaptureDelay`, `engineerTechSecureTime`.
- `AudioVisualRules` — `benderOfSpoons`.
- `GameOpts` — `instantCapture`, `delayedOils`.
- `network/gameopt/Parser` + `Serializer` — 2 new bits.
- `PipOverlay` — cast bar + secure progress sprites.
- `Infantry` — castProgressTrait; `Building` — secureProgressTrait.
- `RenderableFactory` — forced-disguise branch.
- `GameApi` — 5 new player methods; `Bot` — BotContext.

## Not in upstream (fork-only, must be preserved)

LAN stack (`src/network/lan/*`), third-party bot sandbox (`game/ai/thirdpartbot/*`), test tooling
(`tools/*`, `gui/screen/mainMenu/main/TestEntryScreen`), mobile touch controls, storage explorer,
`data/vfs/FileSystem` + browser FileSystemAccess layer, replay stats overlay, sandbox scene tester,
bridge fixes, secondaryWeapon guard fix.

## Applied (2026-08-07)

All of groups A, B and C have been ported into `src/` as TypeScript:

- **A. Gameplay**: `CastProgressTrait` + `UnitCastBarSprite` (engineer capture cast bar, wired via
  `EnterBuildingTask` state machine `Initial→MovingNear→WaitingForDelay→MovingIn→MovingOut`,
  `MoveNextToTask`, `CaptureBuildingTask` delay, `Infantry`, `PipOverlay`,
  `GeneralRules.engineerCaptureDelay`); `SecureProgressTrait` + `SecureProgressSprite` (delayed oil
  capture, `Building`, `GameOpts.instantCapture/delayedOils`, `Parser`/`Serializer` bits,
  lobby options UI in `LobbyForm`/`PregameController`/`PreferredHostOpts`);
  `SpecialWarheadType` (replaces the fork's `friendly` param in `Warhead.detonate`, all ~15 call
  sites, incl. air-distance halving and lightning-strike storm semantics);
  `ForcedDisguisePlugin` (Bender of Spoons, `AudioVisualRules.benderOfSpoons`, April-Fools flag in
  `GameScreen`/`WorldView`/`RenderableFactory`); `PlayerApi` + `BotContext` + `GameApi` options
  param; `MoveNextToTask`.
- **B. Worker pool**: `worker/workerHost` + `worker/workerApi` implemented with the native
  `Worker` API + vite module workers (instead of the `threads` lib, which has no vite support) —
  same `workerHostApi` interface (concurrency, warmUpPool, queueTask, waitForTasks, dispose);
  `decodeWav`/`generateVxlGeometry`/`compressFile` (7z-wasm) run off-main-thread; wired into
  `Gui.ts` (previously `undefined`); `GameLoader` wav decode + vxl preload now active.
- **C. Online WOL stack**: full transport layer (`IrcConnection` protocol engine, `WolConnection`,
  `GservConnection`, `WolService`, `MapTransferService`, `WGameResService`, `GameRes` binary
  packet format, `LockstepManager` deterministic networking, `ActionSerializer`, replay events,
  `WolConfig`/codes/errors/locale, `ServerRegions`, party/qm codes, xwol types); auth layer
  (`AuthService`, `SessionService`, `RealmService`, `CfChallengeHttpRequest`, `CfTurnstile`,
  `GatewayConfig` + `AuthProvidersConfig`, `Config` `[Turnstile]`/`[Gateway]` sections,
  `HttpRequest` credentials + headers); UI (`LoginScreen`, `NewAccountScreen`,
  `RealmSelectionScreen`, `NicknameSelectionScreen`, `QuickGameScreen`, `LobbyScreen`,
  `LadderScreen`, `CfTurnstileWidget`, `CfPreclearanceApi`, `AuthPopupApi`, `PartyState`,
  `PartyInviteDialog`, `SendPartyInviteDialog`, `PlayerContextMenu`, `RecentPlayersList`,
  `BreakingNews`, `AuthProviderButtons`, `NicknameClaimPrompt`, `LoginDebugUi`, game browser
  viewmodel). `MainMenuRootScreen` builds the shared service graph (upstream `Gui.js` wiring
  adapted to the fork's lazy screen factory) and constructs all online screens; `HomeScreen`
  gained Quick Match / Custom Game entries; `Application` constructs `CfTurnstile` and passes
  locale. LAN screens, bot sandbox and test tooling remain reachable.

Known divergences: the fork's `Replay`/`ReplayRecorder` formats are kept (upstream replay-event
classes are ported but standalone); `QuickGameScreen`'s ladder/session wiring uses its own
`SessionService` instance until the shared one is threaded through; `MessageBoxApi` doesn't
support keep-open buttons (upstream claim-prompt uses it); Discord icon is inline SVG.
