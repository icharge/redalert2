# Detailed Function-Level Diff: Upstream 0.83.3 vs TypeScript

Date: 2026-08-13
Supersedes/extends: `docs/handoff-dist-analysis.md`

## Method

All 1,253 `System.register` modules were extracted from `downloaded-game-js/dist/ra2web.min.js` into
`downloaded-game-js/extracted/` as `Path__To__Module.js`. Local source (`src/`, 1,260 files) was compared
pairwise. `git status`: `downloaded-game-js/` is untracked, `public/config.ini` is modified — both preserved.

Dependency conclusion from the handoff still holds: no `package.json` changes are justified.

---

## Part 1 — Handoff features, function by function

### 1. Engineer capture cast progress — EQUIVALENT

- `CastProgressTrait` method inventory identical: `isCasting`, `isCompleted`, `getProgress`, `start`,
  `reset`, `[NotifyTick]`, `[NotifyTeleport]`, `[NotifyOwnerChange]`, `getHash`, `debugGetState`.
  `start(seconds)` identical (`src/game/gameobject/trait/CastProgressTrait.ts:30-38`), `getProgress`
  identical, completion is a flag polled by `EnterBuildingTask` exactly as upstream.
- `UnitCastBarSprite` identical: same ctor params, canvas `barWidth+2 x 4`, `renderOrder 999998`,
  redraw keys and fill logic. Cosmetic only: upstream sets `flatShading:true`, local omits it
  (`src/engine/renderable/entity/UnitCastBarSprite.ts:53-58`). No visible effect.

### 2. Delayed oil capture (SecureProgress) — SIGNIFICANT DIVERGENCE (60x)

- State machine (`isActive`, `getSecuringPlayer`, `getProgress`, `start`, onTick state machine,
  `buildingsCaptured++`, `BuildingCaptureEvent`) identical.
- **Bug:** `SecureProgressTrait.ts:14` computes
  `secureTicks = round(secureSeconds * BASE_TICKS_PER_SECOND)`, upstream multiplies by an extra **60**
  (`60 * secureSeconds * BASE_TICKS_PER_SECOND`). With `EngineerTechSecureTime = 4` @ 15 ticks/s,
  upstream = 3600 ticks (240 s), local = 60 ticks (4 s). Oil capture is 60x faster locally.
- `SecureProgressSprite` pixel-identical (except the same cosmetic `flatShading` omission).

### 3. SpecialWarheadType — EQUIVALENT

Enum identical (`None/Shrapnel/LightningStrike/TntCharge`). All call sites match: `Warhead.ts:396-401,466,532,542,544-549`, `TntChargeTrait.ts:64`, `Projectile.ts:729`, `Debris.ts:115`, `LightningStormEffect.ts:82`, `CaptureBuildingTask.ts:39`, `CrateGeneratorTrait.ts:439`. Defaults are explicit locally where upstream omits the arg — functionally identical.

### 4. Forced disguise / Bender of Spoons — MINOR DIVERGENCE

- `ForcedDisguisePlugin`: update/seen-through/setDisguise/getUiNameOverride identical. **Divergence:**
  local initializes `canSeeThroughDisguise` in the ctor (`ForcedDisguisePlugin.ts:10`); upstream leaves
  it `undefined` so the first `update` always applies the forced disguise. Local never applies the
  initial disguise for non-owners until ownership changes.
- `DisguiseTrait.getDefaultInfantryDisguise` (`DisguiseTrait.ts:55-64`): missing the `ThirdSide →
  thirdDisguise` case (see Part 3, flag A).
- Activation conditions in `RenderableFactory` identical.

### 5. MoveNextToTask — EQUIVALENT LOGIC + KNOWN COMPILE BUG

`chooseTargetFoundationTile`, `hasReachedDestination`, `isCloseEnoughToDest`, constants
(`closeEnoughTiles=Math.SQRT2`, `strictCloseEnough=true`, `ignoredBlockers=[target]`) all identical.
The compile error `MoveNextToTask.ts(37,33)` is a pure rename bug: upstream passes its first parameter
straight through to `super.canStopAtTile`; local renamed the param to `_unit` but still references
`unit`. Fix = rename (upstream uses the same variable for both).

---

## Part 2 — Handoff gaps, analyzed

### Gap 1 (high) — Mesh instancing shader machinery: NOT ported, and currently broken on r183

Upstream `three.shader-patch.js` monkey-patches 6 `THREE.ShaderChunk` chunks to support
`instanceMatrix0..3`, `instanceColor`, `instanceOpacity` under `INSTANCE_TRANSFORM/MATRIX/COLOR/OPACITY/UNIFORM`.

Local state on `three@0.183.2`:
- `THREE.ShaderChunk` is only read, never assigned. No `Object.assign(ShaderChunk,...)`, no `onBeforeCompile`
  injection, nothing in `setupThreeGlobal.ts`.
- `InstancedMesh` extends `THREE.Mesh` (not `THREE.InstancedMesh`), so r183's native `USE_INSTANCING`
  path is never enabled (`isInstancedMesh` falsy → `WebGLPrograms` won't define it).
- `decorateMaterial` sets `INSTANCE_TRANSFORM/UNIFORM/COLOR/OPACITY` defines, and
  `paletteShaderLib.ts:69-70` reads `vInstanceOpacity` in the fragment — but **no vertex shader declares
  `varying float vInstanceOpacity`**. Result: WebGL link error (fragment vary uniform never written).
- Because nothing consumes `instanceMatrix0..3`, every instance renders at the same position (no
  per-instance transform). Shadows/depth pass equally wrong.

Verdict: **mesh instancing with palette materials does not render correctly on r183.** Recommendation
(from analysis): prefer migration to native `THREE.InstancedMesh` (single `instanceMatrix` attribute,
`isInstancedMesh=true`) and keep `instancePaletteOffset`/`instanceExtraLight`/`instanceOpacity` as
divisor-1 attributes; declare the `vInstanceOpacity` varying in `paletteShaderLib`. Fallback: port the
six chunks in `setupThreeGlobal.ts`, adapted to r183 chunk names.

### Gap 2 (medium) — SPE.patch.js emitter behaviors: NOT ported (benign today)

- Local uses the unpatched npm `shader-particle-engine@1.0.6` via `speRuntime.ts` re-export.
- All three patched behaviors are absent: empty-rotation skip, zero-spread exact-color, zero-spread
  exact lifetime. `speCompat.ts` only does the `texture → particleTexture` uniform rename + legacy
  `updateRange`.
- Impact is effectively nil for current configs (SparkFx/DamageSmokeFx/TrailerSmokeFx all use
  spread=0 and non-negative values, where the unpatched methods produce identical bytes). The patch is a
  determinism/CPU optimization plus a `Math.abs`-removal edge for negative values.

### Gap 3 (medium) — VFX: both visibly different from upstream

- `TeslaFx`: upstream = 512-segment Simplex-noise fractal `LightningStrike` prism (0.3*scale radius,
  volumetric). Local = 9-segment `THREE.Line` with sine-wave wiggle, opacity 0.9
  (`TeslaFx.ts:73-122`). Players see thin smooth wires instead of thick jagged bolts. Branching parity
  (none in either). Per-frame geometry alloc/dispose churn locally (3 allocations/frame).
- `LineTrailFx`: upstream = `TrailRenderer` ribbon, head-half gradient via `alphaTest:0.5`, world-scale
  width, normal blend. Local = `three.meshline` ribbon, constant ~0.8px width (`sizeAttenuation:0`),
  **AdditiveBlending + depthTest off** (`LineTrailFx.ts:107-109`) → glows through terrain, full-length,
  dies by uniform fade instead of tail retraction. Same max-length/sample rate formula.
- Inputs (`Projectile.ts:351,367`) match upstream exactly (colors, duration, isElectricBolt/useLineTrail).

### Gap 4 (lower) — Polyfills

- Fullscreen: local uses only standard API (`src/util/fullScreen.ts`, `gui/FullScreen.ts`); no webkit
  (non-prefixed-edge) moz/ms prefixes, no event normalization, no promise shim. Adds F11 handling +
  orientation lock. Partial.
- Web Audio: upstream lazily loads `standardized-audio-context` polyfill when `AudioContext` absent;
  local calls `new AudioContext()` directly with no `webkitAudioContext` fallback
  (`AudioSystem.ts:50`). `StereoPannerNode` used natively with no fallback. Missing for old Safari.
- `poll.js` is a **StrawPoll feedback popup** (not a VXL scheduler). No local equivalent — a feature,
  not a gap.
- `growingpacker.js` → `src/engine/gfx/GrowingPacker.ts` equivalent (global → ESM).
- `lzo1x.js` → `src/data/encoding/lzo1x.ts` — decompress faithful, **`compress()` throws "not
  implemented"** (`lzo1x.ts:251-253`); unused in app paths.

---

## Part 3 — NEW findings (not in the handoff)

### A. ThirdSide missing — HIGH (crash / gameplay)

- Upstream `SideType`: `GDI=0, Nod=1, ThirdSide=2, Civilian=3, Mutant=4`. Local
  (`src/game/SideType.ts:1-6`): `GDI, Nod, Civilian, Mutant` — **`ThirdSide` absent**, values shifted.
- `src/game/rules/CountryRules.ts:40-43` **throws** `Unknown side "ThirdSide"` on any ruleset with a
  Yuri country (`Side=ThirdSide`). Country list is read from runtime ini, so Yuri-inclusive mods/rules
  crash rules loading locally.
- `DisguiseTrait` has no `ThirdSide → thirdDisguise` default; `GeneralRules` has no `thirdDisguise`.
- Game-res `side` serialized as Int — local↔local consistent, but numeric values differ from upstream.

### B. Projectile divergences (5 flags)

- **Prism support beam** (`Projectile.ts:583-589,116,721`): local skips instant + normal detonation for
  `isPrismSupportBeam`; upstream has no skip. Verify against rules data — potential major balance change
  (zero-damage prism support if it should deal damage).
- **Homing final-approach** (`Projectile.ts:339,361-363`): upstream snaps/detonates when
  `distance < LEPTONS_PER_TILE/4` (64 leptons) with bounds check; local only when `moveDistance < 1`,
  no bounds check.
- **Arrival detection** (`Projectile.ts:357`): `moveDistance < currentSpeed` vs upstream
  `d < f && f < 2*LEPTONS`.
- **Shrapnel ground** (`Projectile.ts:750-754`): local checks only `obj.isTerrain()`; upstream also
  includes `obj.isTechno()` → shrapnel won't spawn on techno-occupied ground targets.
- **Parasite/ivanBomb** (`Projectile.ts:624-647,659-661`): local inflicts `Infinity` and skips normal
  detonation (`parasiteInfantryKill`); upstream keeps detonation with infinite damage. `setCharge`
  omits the `obj: fromObject` owner.

### C. AttackTask — INVERTED move-cancel condition (significant)

- In-range block `AttackTask.ts:528-537`: local cancels `MoveInWeaponRangeTask` when ANY of
  (balloonHover&&!hoverAttack | fighter | spawned | Fly-out-of-minRange) apply; upstream cancels when
  NONE apply (i.e. keeps it for fighters/strafers). **Fighters won't strafe; normal units keep a stale
  move task while firing.** This is the inverse of upstream.
- LimboLaunch opportunity-fire: upstream force-cancels the unit's *current* MoveTask; local only cancels
  its own child (`AttackTask.ts:335-342`). Dog/Terror Drone leash differs.

### D. AttackTrait passive acquisition (significant)

`canPassiveAcquire` drops both garrison-occupancy clauses upstream uses (`AttackTrait.ts:422-430`):
occupied/garrisoned buildings are never passively acquired locally.

### E. Game.destroyObject — kills/score inverted for buildings (ladder-relevant)

- Upstream: `killer && (!obj.isBuilding() || originalOwner.isCombatant())`.
- Local (`Game.ts:665`): `killer && (obj.isBuilding() || originalOwner.isCombatant())`.
- Destroying a non-combatant-owned building credits kills/score locally; none upstream.

### F. `Game.getCivilian()` BROKEN — likely crash

`src/game/PlayerList.ts:34` compares `p.country?.side === 'Civilian'` — enum number vs string — always
`undefined`. `getCivilianPlayer()` returns undefined; `removeAllPlayerAssets` then calls
`changeObjectOwner(obj, undefined)` (`Game.ts:852`) for returnable/needsEngineer buildings → owner
corruption / crash.

### G. Game.high-bridge overlay validation dropped

Upstream validates high-bridge overlays vs bridge specs, skips invalid, recalculates
`calculateHighBridgeOverlayId`; local `Game.ts:225-321` skips this. High-bridge maps load differently.

### H. API layer divergences

- `MapApi.findPath` (`MapApi.ts:110-125`): upstream signature `(speedType, isFoot, start, end, options)`.
  Local discriminator `args[0] !== 'boolean'` is a **string-literal comparison, not `typeof`** → the
  isFoot-accepting branch is dead code; an upstream-style call deserializes wrongly and throws
  (`false.tile`). Likely bug.
- `MapApi.getReachabilityMap`: local returns only `isReachable`; upstream also exposes `getRegionId(node)`.
- `GameApi.generateRandomInt` (`GameApi.ts:263-269`): `Math.round(r*(max-min))+min` vs upstream
  `Math.floor(r*(max-min+1))+min` — different range and non-uniform distribution.
- `GameApi.canPlaceBuilding`: local accepts reversed arg order and optional-chains `constructionYard`
  (skips default) where upstream throws on missing building.
- `PlayerApi.canPlaceBuilding` adds 3rd `options` arg; `ActionsApi.queueForProduction/unqueueFromProduction`
  add dual arg-order + swallow errors (upstream throws); `ActionsApi.orderUnits` adds `TargetBridgeMode`
  and local `Target` auto-attaches bridges for bare tiles — different targets on bridge tiles.
- `LoggerApi.setDebugLevel(false)`: upstream WARN, local INFO (`LoggerApi.ts:15`).
- Interface files `TileResourceData`, `PathNode`, `PathFinderOptions`, `BuildingPlacementData`,
  `SuperWeaponData`, `PlayerStats` are `{id: string}` stubs locally, not matching real shapes (real
  shapes inlined in GameApi/MapApi). `ReachabilityMap` and `PlaceCheckOptions` have no files;
  `PlaceCheckOptions` exists only as untyped `options: any` (`GameApi.ts:56`).

### I. Online/network regressions

- **`PlayerConnectionStatus` enum semantics** — upstream numeric `NotConnected=0/Connected=1`; local
  string enum (`PlayerConnectionStatus.ts:1-4`). Online loading screen compares numeric server value to
  `'Connected'` → all players render at 0.5 opacity (`LoadingScreen.tsx:89`).
- **`onJoinGameChannel` missing** in `WolConnection.ts` (dispatched on `JOINGAME` upstream; local only
  `onJoinChannel`, `LobbyScreen.ts:574` now also fires on plain `JOIN`).
- **Load-info wire protocol 6 vs 5 fields**: upstream `serializeLoadInfo` includes `timeoutAt` (parser
  iterates `/6`); local has 5 fields without it (`Serializer.ts:90-106`, `LoadInfoParser.ts:8-23`) —
  cross-client load-progress misparse.
- `handleJoingame` payload `observer`@7 → `fresh`@6 (different key + index); `getLocale` coerces to
  Number; `gameOpt` returns `Promise.resolve()` vs `undefined`.
- **MP loading screen timeout warning dropped** (`MpLoadingScreenApi.ts` lacks the 10 s load-timeout
  tracker; `LoadingScreen.tsx` lacks the status row).
- Replays are a full rewrite: upstream text `.rpl` (`RA2TSREPL_v6`, ReplayEventFactory) vs local binary
  `.ra2replay` (`Replay.ts`, magic `RA2R`, v1). `LockstepManager.ts:156-159` records processed Action
  objects; upstream records raw payloads. Files not cross-compatible.
- Worker protocol: upstream uses `threads`-lib RPC; local is a custom `{id,method,args}` envelope over a
  Vite module worker. Concurrency floor `Math.max(1, (hc||4)-1)` (upstream can be 0). Case difference
  `worker/WorkerApi` vs `worker/workerApi` confirmed.
- `MapTransferService`/`WGameResService`/`WolService`/`gameres/*`: full parity (retry counts, backoff,
  wire formats all match). Only cosmetic log count differences.

### J. GUI regressions

- **`HudChat` broken**: requires an `isComposing` prop that its caller never passes
  (`Messages.ts:80-90` → `isComposing===undefined` → `return null`). In-game chat input never renders.
- `QuickGameForm` drops country/color/party/no-invites UI even though `QuickGameScreen.ts:690-708`
  passes those props — party invites unreachable.
- `ChannelUser`/`GameBrowser`/`QuickGameChat` lost the player context-menu wiring;
  `PlayerContextMenu.tsx` is orphaned dead code.
- `ScoreTable` dropped `isQuit`, MMR, Built columns, points-gain display.
- `Dialog` x/y swapped vs upstream (`Dialog.tsx:46-53`), inconsistent with `Toasts`.
- `Chat.tsx:113-114` drops the `!untrustedContent` guard when URL-formatting.
- `MenuVideo.tsx` omits the logo div that its own `componentDidMount` queries → logo reveal handler dead.
- `GameResBoxApi` lost viewport-resize subscription + debug `console.log` noise.

### K. Core-gameplay minors

- `Weapon.revealOnFire`: local reveals only when `isShrouded`; upstream also on `TemporaryReveal`
  (`Weapon.ts:397-402`).
- `FactoryTrait.NotifyDestroy` missing the `deathType !== DeathType.Temporal` guard
  (`FactoryTrait.ts:73-81`) → delivered units killed on temporal factory destroy.
- `Game.start/init` reorder; `checkGameEndConditions` uses `!getHostilePlayers().length` vs upstream's
  "some pair involves human"; `getCivilian` bug (F); high-bridge validation dropped (G).
- `MoveTrait.ts:203-210` local-only bridge ground-layer fix (naval/water on ground layer) — intentional
  addition.

---

## Part 4 — Inventory: upstream-only and local-only modules

### Upstream-only (95): fully accounted for

Verified equivalents (React/JSX ports) for: chat family, `gui/component/*` primitives, login stack,
nickname/new-account, quick-game, custom-game, lobby dialogs, map-selection, mod-selection, replay,
credits, score, options, game menus, loading screens, game-res import, splash screen, loggers, `main`.

Genuinely-missing upstream behavior: `poll.js` (StrawPoll popup), `onJoinGameChannel`, load-info
`timeoutAt`, MP-load-timeout warning, MP player context menus, QuickGameForm party/country/color UI,
ScoreTable MMR/Built/isQuit, `util/retry` (inlined locally), `WolConnectOptions`/`ScreenParamsMap`
(type-only, harmless).

### Local-only (102): fully accounted for

- **Genuine fork features:** LAN/WebRTC lockstep multiplayer (`src/network/lan/*`, `LanSetupScreen`,
  `LanLoadingScreenApi`, `MobileTouchControls`) — the fork's only working MP path (docs confirm WOL/gserv
  intentionally not implemented); third-party bot sandbox + built-in Supalosa bot port
  (`src/game/ai/thirdpartbot/*`, `AiDifficulty.Custom=5`); performance tools (`performance/*`,
  `tools/*`, `test/performance/*`); replay stats overlay; `PregameController`; `TestEntryScreen`.
- **Renames/restructures:** `GrowingPacker`, `IsoCoords(entity/)`, `Renderable`, `MapObjects` (both),
  `gameobject/Weapon` re-export, `logger` case-rename, `lzo1x`, `workerApi`, `OverlayTibType`.
- **Stubs/placeholders:** `vite-env.d.ts` (empty), `engine/gfx/Camera.ts` (5-line shell), `data/vfs/FileSystem.ts`,
  `game/gameobject/Bridge.ts`, `game/gameobject/Unit.ts` (dead class; upstream `game/gameobject/Unit`
  is also empty — real class is `Vehicle`).

### Bot sandbox caveats (fork feature)

- Sandbox is `new Function` in the main realm with a static forbidden-pattern scan (`BotSandbox.ts:27-47,269`)
  — not true isolation; single-file bots only; `stripTypes` is a fragile regex pass.
- `iceServers: []` in `LanMeshSession.ts` → LAN-only connectivity (no STUN/TURN). `ManualSdpLanSession`
  is orphaned dead code.

---

## Part 5 — Priority fix list

1. **P0:** `SecureProgressTrait.ts:14` — add the upstream `*60`.
2. **P0:** `Game.getCivilian` / `PlayerList.ts:34` — compare against `SideType.Civilian` enum (crash).
3. **P0:** `SideType` + `CountryRules` — add `ThirdSide` (ruleset crash, disguise, game-res values).
4. **P0:** `HudChat` — pass `isComposing` from `Messages.ts` (in-game chat dead).
5. **P0:** `PlayerConnectionStatus` string-vs-numeric — align loading-screen status.
6. **P1:** `AttackTask.ts:528-537` — invert the move-cancel condition; add limboLaunch current-task cancel.
7. **P1:** `MapApi.findPath` discriminator `args[0] !== 'boolean'` → `typeof args[0] !== 'boolean'`.
8. **P1:** `Game.destroyObject` building kills/score condition.
9. **P1:** `AttackTrait.canPassiveAcquire` garrison-occupancy clauses.
10. **P1:** InstancedMesh shader machinery (Gap 1) — migrate to native `USE_INSTANCING` or port chunks.
11. **P2:** Projectile flags B–F (prism beam, homing threshold, shrapnel ground, parasite).
12. **P2:** Load-info 6-vs-5 field protocol.
13. **P2:** `MoveNextToTask.ts:37` compile fix (pure rename).
14. **P2:** `GameApi.generateRandomInt` distribution.
15. **P3:** GUI nits (Dialog x/y, Chat untrusted, MenuVideo logo, GameResBoxApi viewport, QuickGameForm,
    context menus, ScoreTable); VFX parity (TeslaFx/LineTrailFx) if exact parity is required.

Re-run gates after fixes:
```text
bun --bun tsc -p tsconfig.build.json --noEmit
bun test
```

---

## Part 6 — Applied fixes (2026-08-13)

All verified with `tsc -p tsconfig.build.json --noEmit` (clean), `bun test` (7 pass), and
`bun --bun vite build` (1299 modules). The full-project `tsc -p tsconfig.json` still reports many
pre-existing strict-mode errors (`noUnusedLocals`, missing `bun:test` types, mods/tools files) in files
that were not touched; the canonical gate is `tsconfig.build.json`.

### Gameplay
- `SecureProgressTrait.ts:14` — added missing upstream `*60` (oil capture now 240 s @ default instead of 4 s).
- `PlayerList.ts:34` — `getCivilian` compares against `SideType.Civilian` enum, not the string `'Civilian'` (fixes `Game.getCivilian()` crash path).
- `SideType.ts` — restored upstream `ThirdSide = 2` (GDI=0, Nod=1, ThirdSide=2, Civilian=3, Mutant=4).
- `CountryRules.ts` — added `ThirdSide` sideMap entry + `YuriCountry` tooltip (rulesets with Yuri countries no longer throw).
- `DisguiseTrait.ts:61` — added `ThirdSide → generalRules.thirdDisguise` case.
- `GeneralRules.ts` — added `thirdDisguise` field read from `ThirdDisguise`.
- `ParadropRules.ts` — added `yuriParaDrop` read (`YuriParaDropInf/Num`) + `ThirdSide → yuriParaDrop` in `getParadropSquads`.
- `AttackTask.ts` — **inverted** the in-range move-cancel condition (upstream keeps the move task for balloonHover/fighters/spawned/fly units and cancels otherwise; local had it reversed, breaking fighter strafes); expanded limboLaunch to cancel the unit's current MoveTask (or cancel+abort if the current task isn't a MoveTask) and always set forcedMove under limboLaunch, matching upstream. Added `AttackTrait.getOpportunityFireTask()`.
- `AttackTrait.canPassiveAcquire` — restored both garrison-occupancy clauses (insignificant-but-occupied buildings and occupied-building threat) from upstream.
- `Game.destroyObject` — building kills/score condition inverted to match upstream `killer && (!obj.isBuilding() || originalOwner.isCombatant())`.
- `MoveNextToTask.ts:37` — fixed pure-rename compile bug (`_unit` → `unit`).

### API
- `MapApi.findPath` — fixed discriminator `args[0] !== 'boolean'` → `typeof args[0] !== 'boolean'` (the `(speedType, isFoot, start, end, options)` signature was dead code and would crash).
- `GameApi.generateRandomInt` — restored upstream `Math.floor(random * (max - min + 1)) + min` (was `Math.round`, non-uniform + wrong bounds).

### Network
- `PlayerConnectionStatus` — converted string enum to numeric (upstream `NotConnected=0, Connected=1`) + local `Disconnected=2, Lagging=3`. Fixes MP loading screen showing all players at 0.5 opacity.
- `ConInfoForm.tsx` / `DiploForm.tsx` — removed duplicated string constants; now import the shared numeric enum.
- `LoadInfoParser` / `Serializer.serializeLoadInfo` — restored upstream 6-field protocol with `timeoutAt` (was 5 fields → cross-client load-info misparse).
- `ConnectionInfoScreen.ts` / `DiploScreen.ts` — replaced passthrough `LoadInfoParser` stubs with the real parser.

### Render/GUI
- `InstancedMesh` (Gap 1) — migrated to native `THREE.InstancedMesh` (`USE_INSTANCING`): per-instance transform + normals + shadows now work via r183 native path; removed the unused `instanceMatrix0..3` attribute scheme.
- `paletteShaderLib` — declared and assigned `attribute float instanceOpacity` / `varying float vInstanceOpacity` in the vertex stage (fixes the WebGL link error where the fragment read a varying no vertex wrote) and declared the fragment varying.
- `ForcedDisguisePlugin` — removed constructor init of `canSeeThroughDisguise` so the first `update` applies the disguise like upstream (Bender of Spoons now disguises from frame 1 for non-owners).
- `HudChat` — reads `isComposing`/`localPlayer` from `messageList` like upstream (in-game chat input now renders; the caller never passed the required `isComposing` prop).

### Still open (not applied)
- P2 Projectile flags B–F (prism beam damage-skip, homing threshold, shrapnel ground, parasite/ivanBomb) — need rules-data verification; see Part 3 B.
- P3 GUI nits (Dialog x/y, Chat untrusted, MenuVideo logo, GameResBoxApi viewport, QuickGameForm party UI, MP player context menus, ScoreTable MMR/Built/isQuit).
- Gap 2 SPE emitter patches (benign today), Gap 3 VFX parity (TeslaFx/LineTrailFx), Gap 4 polyfills (fullscreen/web-audio), replay binary-format parity.

---

## Part 7 — Applied fixes round 2 (full upstream parity, 2026-08-13)

Second pass to close the remaining gaps from Part 3 and the "still open" list. All verified with
`tsc -p tsconfig.build.json --noEmit` (clean), `bun test` (7 pass), `bun --bun vite build` (1300 modules).

### Gameplay — Projectile (Part 3 B)
- Removed local-only `isPrismSupportBeam` skip (onSpawn + detonate): upstream has **no** prism special-casing in Projectile; support beams now deal their normal damage.
- Homing final-approach: local `moveDistance >= 1` branch → upstream `distanceToTarget >= LEPTONS_PER_TILE/4` (64 leptons); else-branch now bounds-checks the snap (`isWithinHardBounds`).
- Arrival detection: `moveDistance < currentSpeed` → upstream `distanceToTarget < f && f < 2*LEPTONS` (overshoot check).
- Shrapnel ground: `.some(isTerrain)` → `.some(isTerrain || isTechno)`.
- Parasite: infantry now sets `damage = Infinity` and keeps detonation (upstream `h` stays true); only vehicle parasitism skips detonation. Removed `parasiteInfantryKill`.
- ivanBomb: `setCharge` now passes `obj: this.fromObject` (upstream `{player, obj}`).

### Gameplay — Game/Weapon/FactoryTrait
- `Game.createInitialMapOverlays` — restored upstream high-bridge overlay validation: `findMapHighBridgeHeadTiles` + spec lookup (`rectContainsPoint` + new `Bridges.getBridgeSize`), skips `!isHigh` mismatches, recalculates `calculateHighBridgeOverlayId` on X-bridge mismatch; post-loop spec merge now includes `highBridgeSpecs` explicitly.
- `Game.checkGameEndConditions` — `!getHostilePlayers().length` → upstream `!some(pair => !pair.first.isAi || !pair.second.isAi)` (pure-AI games now end).
- `Weapon.revealOnFire` — reveals on `Unexplored || TemporaryReveal` (was `isShrouded` only); `MapShroud.getShroudType` now accepts `(tile, offset)` via the bounds-safe `rxyzToSxy` path like upstream.
- `FactoryTrait.NotifyDestroy` — added `building.deathType !== DeathType.Temporal` guard (temporal-destroyed factory spares the delivering unit).

### API
- `GameApi.canPlaceBuilding` — strict upstream signature `(playerName, buildingType, position, options)`, `options.ignoreAdjacent ??= getBuilding(...).constructionYard` (throws on missing building).
- `LoggerApi.setDebugLevel` — `debug ? DEBUG : WARN` (was INFO).

### Network (Part 3 I)
- `WolConnection` — added `_onJoinGameChannel`/`onJoinGameChannel` getter + second dispatch in `handleJoingame`; payload now `{name, operator:false, ping:[5], observer:[7]?}` (was `fresh`); `LobbyScreen` subscribes `onJoinGameChannel`; `handlePlayerJoinLeave` routes observers via `user.observer` to OpenObserver slots like upstream.
- `getLocale` — returns the raw string `params[2].split("`")[1] ?? WolLocale.Unknown` (was `Number(...)`).
- `gameOpt` — returns `void` (was `Promise.resolve()`); all 8 `send*` wrappers now return `void`.
- `MpLoadingScreenApi` — ported upstream load-timeout machinery: `loadTimeoutFirstSeenByPlayer` map, `createClientPlayerLoadInfo`, 1 s refresh interval, `showLoadTimeoutStatus` (10 s), and `ping`/`lagAllowanceMillis`/`timeoutAt` propagation. `LoadingScreen` renders the `TS:LoadTimeoutStatus` row via `getTimeoutStatusText`.
- Worker concurrency floor: **kept** `Math.max(1, (hc||4)-1)` — upstream `(hc||4)-1` can be 0, which breaks the local eager worker pool; intentional divergence.

### GUI (Part 3 J)
- `Dialog` — `getWrapperStyle` swapped back to upstream `top: viewport.x, left: viewport.y` (was reversed vs Toasts).
- `Chat` — restored `!message.untrustedContent` guard on URL formatting.
- `MenuVideo` — restored the `<div class="logo">` element and removed the early-return guard (logo fade + File/MediaSource fallback now work).
- `GameResBoxApi` — added `viewport.onChange` resize subscription (via new `Viewport.onChange` + `ViewportAdapter.onChange`); removed debug logs.
- `QuickGameForm` — restored upstream country/color selects, party invite + no-invites UI, and the full ladder profile fieldset (placement, rank, promo-progress ▲/▼, wins, points, bonusPool, MMR + info tooltip); ranked control now uses upstream `"1"/"0"` values + `GUI:Ranked`/`GUI:Unranked`; Solo1v1 disabled at party size 2.
- `ChannelUser` — now accepts `menuItems` + `localUsername`, opens the context menu on click/contextmenu (self excluded), renders the ▼ indicator + `PlayerContextMenu`, uses upstream rank predicate (`rank !== undefined`).
- `GameBrowser` / `QuickGameChat` — build whisper/invite menu items and pass `localUsername` + `menuItems` to `ChannelUser`; `ChatUi.getChatProps` adds `onInviteToTeam` → `wolCon.partyInvite`. `PlayerContextMenu` is now live (was dead code).

### Version
- `src/version.ts` — `0.0.1` → `0.83.3` (upstream). `Engine.getVersion()` → `0.83`. `GameLoader` bot-version check self-passes via the fallback `{ version: appVersion }`.

### Remaining intentional/non-parity items
- Gap 2 SPE emitter patches (benign; uniform rename already in place).
- Gap 3 VFX (TeslaFx/LineTrailFx) — intentional replacements; visual parity not guaranteed.
- Gap 4 polyfills (fullscreen/web-audio) — targeted modern browsers; no older-WebKit shims.
- Replay binary format (`.ra2replay` vs upstream text `.rpl`) — rewrite, not cross-compatible.
- Fork additions kept as-is: LAN/WebRTC, bot sandbox + built-in bot, performance/tools, `PregameController`, `MobileTouchControls`, `ReplayStatsOverlay`, `Target` bridge auto-attach.

---

## Part 8 — Applied fixes round 3 (deep parity sweep, 2026-08-13)

Third pass driven by four deep-comparison agents (traits, locomotors/orders/tasks, superweapons/
triggers/actions, engine/renderable/sound) plus the VXL-shader investigation. Verified: `tsc -p
tsconfig.build.json --noEmit` clean, `bun test` 7/7, `bun --bun vite build` (1300 modules).

### VXL shader / shadow (user-reported shadow issue)
- `ExtraLightHelper.multiplyVxl` — was `copy(source).multiplyScalar(max(0,1+radius))` (ignored `intensity`,
  multiplicative); restored upstream `copy(source).addScalar(2 * radius * intensity)` (additive). This was
  the root cause of VXL brightness divergence during highlight/invuln.
- Removed the `Math.PI * 1.5` constant added to every VXL extraLight base (`Vehicle`, `Building`, `Aircraft`,
  `Projectile`, `Debris` ×3) — upstream has no such offset.
- `Overlay` — high bridges now get a shadow: `hasShadow` includes high bridge (upstream `hasShadow &&
  !isLowBridge()`) and `createBridgeShadowSurface()` is now called in the high-bridge branch (was dead code).
- `Building.createLamp` — restored upstream negative-tint offset (`abs(min(r,g,b,0))`) before scaling.
- `Animation.computeNextFrame` — `endLoopFlag` case now returns true without changing frameNo/clearing
  `playToEndFlag` (upstream behavior).
- `WorldScene.update` — now passes `time` through to `super.update(deltaTime, time)` (was dropped; sub-frame
  movement interpolation in Vehicle/Projectile/Debris restored).
- `Projectile` sonic wave color `0xbcbc` → upstream `0xBCD4`.
- `VxlGeometryCulledBuilder` — latent bug noted (dead code, `Float32Array(3 * BoxGeometry)` = NaN); not invoked.

### Gameplay orders/tasks
- `MoveAsideTask` — fixed param-shadowing bug (was pushing enemy units: `unit.owner === unit.owner`).
- `AttackOrder` — overlay wall/wood validation inverted (fixed); added missing fly vertical-weapon
  move-cancel clause; spawner bounds now via `getSpawnerTargetTile()`.
- `CheerTask` — non-cheerable units now complete the task (was false → queue stall).
- `GuardAreaOrder` — full harvester now gets `ReturnOreTask` (was always `GatherOreTask`).
- `EnterBuildingTask` — `lastOutsideTile` condition inverted (fixed); task now completes after `onEnter` when
  `onEnter` returns truthy.
- `EvacuateTransportTask` — restored the 30-tick `WaitTicksTask` after exit.
- `GatherOreTask` — restored `1e5 * tibTrait.rules.value` primary sort key + `tibTrait` capture; no-ore search
  from `unit.tile`.
- `PsychicDetectorTrait` — range-checks each detection target (upstream) instead of the source unit.

### Traits
- `ParasiteableTrait` — all four methods aligned: `onHeal` (unitRepair destroys even organic), `onDamage`
  (stores `lastAttacker` + `weapon.rules.damage`), `onDestroy`/`shouldSupressParasite` (invuln guard + base
  damage + `2*(base-threshold)` window), `onBeforeTeleport` (suppress→destroy).
- `WarpedOutTrait` — now dispatches via two distinct symbols (game-level for `context.traits`, object-level
  for `gameObject.traits`).
- `MindControllableTrait.restore` — defeated prevOwner → `world.getCivilianPlayer()`.
- `CrewedTrait` + `CrewRules` — added ThirdSide branch + `thirdCrew`/`thirdSurvivorDivisor`.
- `TransportTrait` — deathType propagated to passengers; sink+deathWeapon-clear in water evac path.
- `DockableTrait` — unreserves dock on teleport; `GarrisonTrait` — evacuees get onBridge + tileElevation 0;
  `HospitalTrait` — unit deathType set; `SpawnLinkTrait` — only adds MoveTask when no current task;
  `IdleActionTrait` — fraidycat scatter only for neutral owners; `FreeUnitTrait` — `rules.soylent ||
  purchaseValue` refund; `UnitRepairTrait` — start-event OR condition; `TntChargeTrait` — Sink also excluded.

### Engine / sound / renderable
- `Engine` — added `activeEngine` field + `getActiveEngine()` (throws when unset) + `setActiveEngine()`; the
  app now calls `Engine.setActiveEngine(EngineType.RedAlert2)` before `loadRules`. Added
  `patchAudioVisualRules()` (YR rule merge, no-op for RA2) and `getSoundIni()` (sound.ini+soundcd.ini merge);
  `Gui` uses it.
- `mixDatabase` — added `thememd.mix` entry.
- `SoundKey` — added `PartyInvite = 76`, `PartyFormed = 77`.
- `EvaSpecs` — ThirdSide → Yuri prefix map + throw on unknown side.
- `Terrain` — `lastTiberiumSpawnStatus` recorded on any status change; reset only when Spawning.

### Superweapons / triggers / actions
- `CreateCrateExecutor` + `CrateGeneratorTrait` — restored `searchRadius=3` + `cratesAppear` (persistent
  crates) + `RadialBackFirstTileFinder` relocation; `canPlaceCrateOnTile` now ignores smudges.
- `ChangeHouseExecutor` / `ChangeHouseAllExecutor` — fixed `Number(action.params[1])` index bug + added
  defeated→ally redistribution fallback.
- `FireSaleExecutor` / `GlobalVariableExecutor` — fixed `action.params[1]` index bug.
- 12 trigger conditions — fixed `Number(params[1])` reading `event[1]` (undefined→NaN) → `Number(params.params[1])`.
- `RandomDelayCondition` — `!this.timerTicks` → nullish `??=` (delay=0 no longer re-rolls).
- `IronCurtainEffect` — `isDestroyed` now skips all objects (was only organic).
- `SelectUnitsAction` — falls back to any world techno when the player-owned lookup fails.
- Kept intentional: `OrderUnitsAction` bridge-aware wire format (local upgrade), `ResourceLoader` trailing
  slash, `WorldSound` Screen/Local (already equivalent).

### SPE (Gap 2)
- `speCompat.ts` — ported the three upstream `SPE.patch.js` emitter behaviors: empty-rotation skip,
  zero-spread exact-color, zero-spread exact lifetime (`_assignRotationValue`/`_assignColorValue`/
  `_assignAbsLifetimeValue`). Verified the npm SPE build has `setVec4Components`/`arrayValuesAreEqual`.

### Remaining non-parity (intentional / fork-only)
- Replay binary format (`.ra2replay` vs `.rpl`) — rewrite, not cross-compatible.
- Fork additions: LAN/WebRTC, bot sandbox + built-in bot, performance/tools, `PregameController`,
  `MobileTouchControls`, `ReplayStatsOverlay`, `Target` bridge auto-attach, bridge render-order/depth hacks,
  SRGB output, octree-library adaptation, `OrderUnitsAction` bridge wire format, `ResourceLoader` slash.

---

## Part 9 — Applied fixes round 4 (final sweep, 2026-08-13)

Closed the remaining items from the "still remaining" list. Verified: `tsc -p tsconfig.build.json --noEmit`
clean, `bun test` 9/9 (incl. new replay round-trip tests), `bun --bun vite build` (1308 modules).

### Polyfills (Gap 4)
- `src/util/fullscreenPolyfill.ts` — ported the upstream `fullscreen-api-polyfill.min.js` (webkit/moz/ms
  prefix detection, W3C-name aliasing, event normalization, Promise wrapping for exit/request). Called from
  `FullScreen.init()`; `setupFullScreenChangeListener` now also listens to the prefixed fullscreenchange
  events.
- `AudioSystem.initialize()` — uses `window.AudioContext || webkitAudioContext` fallback; `playAudioBuffer`
  falls back to a manual/`PannerNode` path when `createStereoPanner` is unsupported.

### VxlGeometryCulledBuilder
- Fixed the latent NaN bug: attributes built from the accumulated `u`/`d`/`g` arrays (`new
  Float32Array(u)` etc., itemSize 3) instead of `3 * BoxBufferGeometry`/`4 * t`.

### Harvester economy stat
- `HarvesterTrait` — added `_ore`/`_gems` getters, `bails` Map, `addBails`/`getBails`/`empty()`.
- `ReturnOreTask` — unload now computes value from `getBails()`, adds `creditsGained`, calls `empty()`.
- `GatherOreTask` — harvest routes through `addBails`.
- `Player` — added `creditsGained`; `OilDerrickTrait` increments it (and fixed the
  `oldOwner.isNeutral` check vs `world.isNeutral`).

### VFX parity (Gap 3)
- Vendored upstream `LightningStrike` and `SimplexNoise` into `src/engine/renderable/fx/vendor/` as r183
  class-based ES modules (super-based construction, `setAttribute`, `DynamicDrawUsage`,
  `MathUtils.lerp`).
- Vendored upstream `TrailRenderer` into `vendor/TrailRenderer.js` (r183: `setAttribute`,
  `DynamicDrawUsage`, no `updateRange`, no `mesh.dynamic`).
- `TeslaFx` — now creates 3 `LightningStrike` bolts (primary/primary/secondary) with the upstream params
  (`isEternal`, `timeScale:2`, `ramification:0`, `roughness:0.85`, `straightness:0.7`,
  radius 0.3·ISO_WORLD_SCALE).
- `LineTrailFx` — now uses `TrailRenderer` with the upstream head/tail color gradient, billboarded
  `PlaneGeometry` head cross-section (rotated to camera), `requestFinishAndDispose` = 0.8 s,
  `stopTracking` freezes the target matrix.

### Replay format rewrite (Gap 5)
- `Replay` — rewritten to the upstream text `RA2TSREPL_v6` format: header tag + `ENGINE` line + game
  id/time/opts line + `tick=type|payload` event lines + `END <tick>` (+ optional Base64 debugInfo).
  Kept the local public API (`name/timestamp/gameId/gameTimestamp/gameOpts/engineVersion/modHash/
  endTick/finish/serialize/unserialize/parseHeader/sanitizeFileName`) and added `init/writeEvent/
  getEvents/flush`. `extension` is now `.rpl`. Supports reading v5 (Base64 opts) and v6.
- `ReplayRecorder` — emits typed `TurnActionsReplayEvent` (batched per tick, `{id, params}` payloads,
  NoAction filtering) plus `ChatMessageReplayEvent`/`TauntReplayEvent`; no more hash checkpoints.
- `ReplayTurnManager` — upstream iterator/`doGameTurn` pattern (`onReplayEvent` dispatch +
  `processActions` for TurnActions, `GameStatus.Ended` at `endTick+1`, speed-change handling); kept the
  local `onReplayEvent`/`onActionsSent`/`onFinished` dispatchers used by ReplayScreen/GameScreen.
- `Gui` — GameScreen/ReplayScreen now receive `Engine.getVersion()` (`0.83`) as `engineVersion`, matching
  the upstream ENGINE line regex (`\d+\.\d+`), instead of the full `0.83.3`.
- Added `src/test/Replay.test.ts` verifying the text serialize→unserialize round-trip and header parse.

### Remaining (intentional / fork-only — no upstream equivalent)
- LAN/WebRTC, bot sandbox + built-in bot, performance/tools, `PregameController`, `MobileTouchControls`,
  `ReplayStatsOverlay`, `Target` bridge auto-attach, bridge render-order/depth hacks, SRGB output,
  octree-library adaptation, `OrderUnitsAction` bridge wire format, `ResourceLoader` slash normalization.
