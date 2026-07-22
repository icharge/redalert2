# Architecture

This document describes the codebase layout, module boundaries, and how the major subsystems fit together. It is intended to help new contributors orient themselves quickly.

## Directory Layout

```text
redalert2/
├── public/                 # Static web assets, config.ini, locale JSON, legacy CSS
├── scripts/                # Playwright regression and debug flows
├── docs/                   # This documentation
├── src/
│   ├── App.tsx             # React root component
│   ├── main.tsx            # Entry point: mounts React, registers bots
│   ├── Application.ts      # Bootstraps config, resources, routing, GUI
│   ├── Gui.ts              # Top-level UI controller / screen manager
│   ├── Config.ts           # Parsed config.ini
│   ├── ConsoleVars.ts      # Runtime debug / cheat variables
│   ├── LocalPrefs.ts       # localStorage wrapper
│   ├── RouteHelper.ts      # URL routing helpers
│   ├── data/               # Original game format parsers
│   ├── engine/             # Rendering, audio, resource loading, engine state
│   ├── game/               # Simulation logic
│   ├── gui/                # React / UI screens and components
│   ├── network/            # Multiplayer networking, replay, ladder
│   ├── performance/        # Performance counters and telemetry
│   ├── tools/              # Standalone tester / debug pages
│   ├── types/              # Shared TypeScript declarations
│   ├── util/               # Utilities: math, events, routing, strings, etc.
│   └── version.ts          # Application version
├── vite.config.ts          # Vite build config
├── tsconfig.json           # TypeScript base config
└── package.json            # Dependencies and scripts
```

## Module Boundaries

The project is organized into layers. Lower layers should not depend on higher layers.

### 1. Data Layer (`src/data/`)

Pure parsers and containers for original game formats. No React, no Three.js scene logic, no game rules.

| Sub-area | Responsibility |
|----------|----------------|
| `data/*.ts` | Format parsers: `ShpFile`, `VxlFile`, `TmpFile`, `Palette`, `MixFile`, `CsfFile`, `IniFile`, `WavFile`, `Mp3File`, etc. |
| `data/encoding/` | Compression/encryption: `Format80`, `Format3`, `Format5`, Blowfish, LZO. |
| `data/vfs/` | Virtual File System: `VirtualFileSystem`, `RealFileSystem`, `VirtualFile`, `MemArchive`, `RealFileSystemDir`. |
| `data/map/` | Map metadata helpers (`MapFile`, map objects, lighting, special flags, variables, cell tags). |
| `data/vxl/`, `data/hva/` | Voxel / HVA-specific helpers. |
| `data/zip/` | Archive extraction helpers used during import. |

Key seam: `VirtualFile` is the currency. Anything that reads a file receives a `VirtualFile` with a `DataStream`.

### 2. Engine Layer (`src/engine/`)

Static registries, resource loading, and low-level runtime systems.

| Sub-area | Responsibility |
|----------|----------------|
| `Engine.ts` | Static singleton registries for INIs, images, voxels, sounds, theaters, rules, palettes, and the active mod hash. |
| `engine/gameRes/` | `GameRes` bootstraps the file system, imports game files, CDN fallback, caching, mod loading. |
| `engine/gfx/` | Three.js renderer, camera, batching, sprite/voxel builders, texture atlases, utilities. |
| `engine/renderable/` | Bridge from game objects to Three.js objects: `WorldScene`, `RenderableFactory`, `MapSpriteBatchLayer`, `MapShroudLayer`, `MinimapRenderer`, etc. |
| `engine/sound/` | `AudioSystem`, `Music`, `Eva`, `Mixer`, `WorldSound`, sound specs. |
| `engine/animation/` | Animation loop helpers (`GameAnimationLoop`, `UiAnimationLoop`, `Engine.ts` animation support). |
| `engine/MapList.ts`, `MapManifest.ts`, `MapSupport.ts`, `Theater.ts` | Map discovery, theater switching, tile loading. |
| `engine/resourceConfigs.ts` | CDN / prefetch resource manifest definitions. |

Key seam: `Engine.loadRules()` and `Engine.loadTheater()` move the engine from "resources loaded" to "ready to simulate a specific map."

### 3. Game Simulation Layer (`src/game/`)

The deterministic simulation. This is the heart of Red Alert 2 logic.

| Sub-area | Responsibility |
|----------|----------------|
| `Game.ts` | Top-level simulation. Owns `currentTick`, `currentTime`, players, world, map, rules, traits, triggers, construction workers. |
| `game/gameobject/` | Units, buildings, infantry, aircraft, projectiles, overlays, terrain, smudges, and their traits. |
| `game/gameobject/unit/` | Vehicle logic: locomotors, weapons, veterancy, disguises, special abilities. |
| `game/gameobject/infantry/` | Infantry-specific logic. |
| `game/gameobject/Building.ts` | Building logic, construction, power, radar, superweapon buildings (flat file, not a subfolder). |
| `game/trait/` | Modular traits: selection, production, harvester, disguise, cloak, mind control, etc. |
| `game/trigger/` | Map trigger system: conditions and executors. |
| `game/rules/` | INI rule parsing and runtime object rule builders (`Rules` object, weapons, warheads, superweapons). |
| `game/superweapon/` | Nuke, Lightning Storm, Chronosphere, Iron Curtain, etc. |
| `game/ai/` | Bot managers, strategies, missions, squads, threat maps, production logic. |
| `game/ai/thirdpartbot/` | Adapter for pluggable third-party bots plus built-in implementations. |
| `game/order/`, `game/action/` | Player commands and their in-game execution. |
| `game/player/` | Player state: credits, country, color, alliances, defeated status. |
| `game/map/` | Runtime map data: tiles, passability, ore spread, bridges, shroud, pathfinders. |
| `game/math/`, `game/type/` | Shared math helpers and type enums. |
| `game/event/`, `GameEventBus.ts` | In-game event dispatch. |

Key seam: `Game.update()` advances one tick. Actions from the local player or network are processed before `Game.update()` in the current tick.

### 4. GUI Layer (`src/gui/`)

React-based user interface and bridge to the engine/simulation.

| Sub-area | Responsibility |
|----------|----------------|
| `gui/component/` | Reusable React components (buttons, error boxes, splash screen, image context). |
| `gui/screen/mainMenu/` | Main menu and sub-screens: login, lobby, map selection, options, ladder, LAN, etc. |
| `gui/screen/game/` | In-game UI: HUD, command bar, world interaction, game menu, minimap, placement mode. |
| `gui/screen/replay/` | Replay viewer UI. |
| `gui/jsx/` | Custom JSX/UI rendering bridge for non-React UI surfaces. |
| `gui/chat/` | In-game and lobby chat UI. |

Key seam: `Gui.ts` manages screen lifecycle and mounts React roots. React screens communicate with the simulation through `Game`, `World`, and session objects passed as props.

### 5. Networking Layer (`src/network/`)

Multiplayer transport, lobby state, match synchronization, and replays.

| Sub-area | Responsibility |
|----------|----------------|
| `network/lan/` | WebRTC mesh, room session, match session, lockstep turn manager, QR-code payloads, SDP diagnostics. |
| `network/gameopt/` | `Parser` / `Serializer` for player actions and game options, `SlotInfo`. |
| `network/gamestate/` | Replay recording and playback (`Replay`, `ReplayRecorder`, `ReplayTurnManager`, `SoloPlayTurnManager`). |
| `network/ladder/` | Ladder service client and ranking types. |
| `network/HttpRequest.ts` | HTTP fetch wrapper with progress and cancellation. |
| `network/IrcConnection.ts`, `WolConnection.ts` | Legacy-style server connection stubs (WOL/IRC). |

See [`networking.md`](networking.md) and [`online-play.md`](online-play.md) for details.

### 6. Tools Layer (`src/tools/`)

Standalone debug / regression pages.

| Tool | Purpose |
|------|---------|
| `VxlTester` | Voxel model rendering tests |
| `ShpTester` | Sprite rendering tests |
| `SoundTester` | Audio playback tests |
| `BuildingTester`, `InfantryTester`, `VehicleTester`, `AircraftTester` | Object-type regression |
| `WorldSceneTester`, `UnitMovementTester`, `SceneSandboxTester` | Map / movement / scene tests |
| `LobbyFormTester` | Lobby UI tests |
| `PerformanceTester` | Performance smoke tests |
| `LiveInteractionTester` | End-to-end interaction tests |

These pages are not demos — they are primary regression entry points used by `scripts/*-flow.mjs`.

## Data Flow

### Boot Flow

```text
main.tsx
  └── App.tsx
        └── new Application()
              ├── loadConfig()          ← /config.ini
              ├── loadTranslations()    ← .csf + JSON locale
              └── main()
                    └── new GameRes()
                          ├── initRfs() / initVfs()
                          └── loadResources()
                                └── Engine.loadRules()
                    └── initRouting()
                          └── new Gui()
```

### Game Start Flow

```text
Gui / MainMenu
  └── selects map + game options
        └── creates GameSession / BattleControlApi
              ├── loads theater via Engine.loadTheater()
              ├── builds Game instance
              ├── builds WorldScene + Renderables
              └── starts GameAnimationLoop
                    ├── GameTurnManager.doGameTurn()
                    │     ├── collect network/local actions
                    │     └── Game.update()
                    └── Renderer.update() + render()
```

### Multiplayer Game Flow

```text
LanRoomSession (lobby)
  └── startGame()
        └── LanLaunchDescriptor
              └── LanMatchSession (in-match transport)
                    └── LanLockstepTurnManager
                          ├── submitLocalTurn() per tick
                          ├── tryConsumeTurn() waits for all peers
                          └── Game.update()
```

## Coupling Rules

- `data/` has no dependencies on `engine/`, `game/`, or `gui/`.
- `engine/` may depend on `data/` and `util/`. It should not import React components.
- `game/` may depend on `data/`, `engine/` (types/resources only, not rendering), and `util/`.
- `gui/` may depend on all lower layers.
- `network/` may depend on `game/` types and `util/` but should not depend on `gui/`.
- `tools/` may depend on anything.

## Important Files to Know

| File | Why It Matters |
|------|----------------|
| `src/Application.ts` | Boot entry, viewport, routing, GameRes init |
| `src/Engine.ts` | Static registries and theater/rules loading |
| `src/game/Game.ts` | Main simulation object |
| `src/engine/GameAnimationLoop.ts` | Runs render + simulation ticks |
| `src/network/lan/LanRoomSession.ts` | Pre-game lobby and map transfer |
| `src/network/lan/LanMeshSession.ts` | WebRTC room and peer mesh |
| `src/network/lan/LanMatchSession.ts` | In-match action synchronization |
| `src/network/lan/LanLockstepTurnManager.ts` | Lockstep tick processing |
| `src/engine/gfx/Renderer.ts` | WebGL renderer wrapper |
| `src/engine/renderable/WorldScene.ts` | Scene composition |
| `src/data/vfs/VirtualFileSystem.ts` | File lookup across archives |
| `src/game/rules/` | Rule parsing and object stats |
| `src/game/ai/` | AI logic |
