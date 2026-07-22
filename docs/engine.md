# Engine

This document explains the engine layer: how assets are loaded, how the virtual file system works, how the simulation and render loops are driven, how the world is rendered, and how audio is produced.

## 1. Asset Loading and the Virtual File System

The original Red Alert 2 assets live in `.mix` archives and various side directories. RA2WEB React abstracts all of these into a **Virtual File System (VFS)** layered over a **Real File System (RFS)**.

### Real File System (`src/data/vfs/RealFileSystem.ts`)

- Wraps browser storage: native `FileSystemDirectoryHandle` when available, otherwise an IndexedDB-backed adapter via `file-system-access`.
- Provides `openFile()`, directory traversal, and writable handles.
- Imported assets are persisted here so the user only has to import once.

### Virtual File System (`src/data/vfs/VirtualFileSystem.ts`)

- Maintains a prioritized stack of **archives**.
- Each archive implements `containsFile(filename)` and `openFile(filename)` returning a `VirtualFile`.
- Archives can be:
  - A `MixFile` (Westwood archive)
  - An `AudioBagFile` (BAG + IDX audio archive)
  - A `MemArchive` (in-memory)
  - A pass-through to RFS

When code asks for `vfs.openFile("rules.ini")`, the VFS walks the archive stack from highest to lowest priority and returns the first match.

### Lazy Resource Collections

`Engine.ts` holds static lazy collections:

```ts
Engine.images  // LazyResourceCollection<ShpFile>
Engine.voxels  // LazyResourceCollection<VxlFile>
Engine.sounds  // LazyResourceCollection<WavFile>
Engine.iniFiles// LazyResourceCollection<IniFile>
Engine.palettes// LazyResourceCollection<Palette>
Engine.tileData// LazyResourceCollection<TmpFile>
Engine.themes  // LazyAsyncResourceCollection<Mp3File>
Engine.taunts  // LazyAsyncResourceCollection<WavFile>
```

These are keyed by filename and parse on first access. They all use the VFS internally, so the caller does not need to know whether a file came from a mix archive, a local file, or a CDN.

### GameRes Bootstrap (`src/engine/gameRes/GameRes.ts`)

`GameRes.init()` is responsible for:

1. Choosing a storage adapter (native or IndexedDB fallback).
2. Migrating old IndexedDB storage to native FS if possible.
3. Initializing `Engine.rfs` and `Engine.vfs`.
4. Loading the mod directory (`mods/`) and map directory (`maps/`) into RFS.
5. Loading required base archives and CDN resources.
6. Calling `Engine.loadRules()` to merge `rules.ini` + `rulescd.ini` and `art.ini` + `artcd.ini`.

If no local files exist, `GameRes` shows an import dialog that can accept a folder, a `.zip`/`.7z` archive, or a URL. Archives are extracted using `7z-wasm`.

### CDN Mode

In hosted deployments, `GameResConfig` can point at a CDN base URL. The `CdnResourceLoader` fetches a manifest and resources over HTTP, populating the VFS with in-memory archives.

## 2. Rules and Theaters

### Rules Loading

`Engine.loadRules()`:

1. Reads `rules.ini` and `rulescd.ini` (or the Yuri's Revenge `md` variants).
2. Reads `art.ini` and `artcd.ini`.
3. Reads `ai.ini`.
4. Merges base + custom INIs for rules and art.
5. Computes a `modHash` over key files for multiplayer consistency.

The merged INIs become the authoritative rule database used by `game/rules/` and `Game.ts`.

### Theater Loading

A **theater** is a tileset: Temperate, Snow, Urban, NewUrban, Desert, Lunar. `Engine.loadTheater(type)`:

1. Looks up `Engine.theaterSettings` for the active engine (RA2 or YR).
2. Adds the relevant `.mix` files to the VFS (e.g., `isotemp.mix`, `temperat.mix`).
3. Parses the theater INI (`temperat.ini`) and tile TMP data.
4. Caches the `Theater` instance in `Engine.theaters`.

## 3. Game Loop

The simulation runs on a fixed tick. Rendering runs independently and interpolates between ticks.

### GameAnimationLoop (`src/engine/GameAnimationLoop.ts`)

- Uses `requestAnimationFrame` while the tab is visible.
- Computes how many simulation ticks have elapsed based on `gameTurnMgr.getTurnMillis()`.
- Calls `gameTurnMgr.doGameTurn(timestamp)` for each elapsed tick.
- Calls `renderer.update(timestamp, interpolation)` and `renderer.render()` once per frame.
- When the tab is hidden, switches to a background `setInterval` so non-observer players continue simulating.

```text
per frame:
  deltaFrames = elapsed ticks since last frame
  for each deltaFrame:
      turnMgrIsWaiting = !gameTurnMgr.doGameTurn()
  renderer.update(timestamp, interpolation)
  renderer.render()
```

### Turn Managers

The turn manager is the interface between the loop and the simulation.

- **SoloPlayTurnManager** (`src/network/gamestate/SoloPlayTurnManager.ts`) — single-player / skirmish: dequeues local actions and calls `Game.update()`.
- **ReplayTurnManager** — reads recorded actions per tick.
- **LanLockstepTurnManager** — multiplayer. See [`online-play.md`](online-play.md).

All turn managers implement:

```ts
interface GameTurnManager {
    getTurnMillis(): number;
    doGameTurn(timestamp: number): boolean; // true = tick processed, false = waiting
    setErrorState(): void;
    setPassiveMode?(passive: boolean): void;
}
```

## 4. Simulation (`src/game/Game.ts`)

`Game` is the deterministic simulation state machine.

Key responsibilities:

- Owns `currentTick` and `currentTime`.
- Maintains `updatableObjects` — all objects that receive a tick update.
- Owns `playerList`, `alliances`, `triggers`, `botManager`, `objectFactory`.
- Processes queued actions from the turn manager.
- Spawns initial map objects and starting units.
- Checks victory/defeat conditions.

`Game.update()`:

1. Updates all registered objects and traits.
2. Updates construction workers (building queues).
3. Updates the bot manager (AI).
4. Updates triggers.
5. Updates countdown timers.
6. Fires after-tick callbacks.

Because the simulation is deterministic, every peer in a multiplayer match must receive the same action stream in the same tick order.

## 5. Rendering

### Renderer (`src/engine/gfx/Renderer.ts`)

A thin wrapper around `THREE.WebGLRenderer`:

- Creates a high-performance WebGL context.
- Manages a set of `Scene` objects, each with its own viewport.
- Each frame: clears, sets viewport, clears depth, renders each scene.
- Supports `stats.js` overlay in dev mode.
- Handles WebGL context loss / restore.

### WorldScene (`src/engine/renderable/WorldScene.ts`)

Composes the in-game Three.js scene:

- Map tile layers (`MapTileLayer`, `MapSpriteBatchLayer`).
- Object renderables (buildings, vehicles, infantry, aircraft, projectiles).
- Overlay layers (tiberium, bridges, smudges).
- Shroud layer (`MapShroudLayer`).
- Effect layers (lasers, trails, smoke, superweapons).
- Minimap render target (`MinimapRenderer`).

### Renderable Factory

`RenderableFactory` maps game objects to visual representations:

- `Building` → `ShpRenderable` or batched SHP builders.
- `Vehicle` / `Infantry` → `VxlBuilder` variants (batched, non-batched, instanced).
- `Projectile`, `Anim`, `Overlay`, `Terrain`, `Smudge` → specialized renderables.

### Sprite and Voxel Pipeline

- **SHP sprites** are decoded from `ShpFile`, optionally composed into texture atlases (`ShpTextureAtlas`, `TextureAtlas`) to reduce draw calls.
- **VXL voxels** are converted to `BufferGeometry` with palette-based materials. There are multiple builders:
  - `VxlBatchedBuilder` — merges geometry for static batches.
  - `VxlNonBatchedBuilder` — individual meshes.
  - `VxlGeometryMonotoneBuilder`, `VxlGeometryNaiveBuilder` — different mesh generation strategies.
  - `VxlGeometryCache` — caches generated geometry.
- Materials use palette-based shaders (`PaletteBasicMaterial`, `PaletteLambertMaterial`, `PalettePhongMaterial`, `paletteShaderLib`) so the original 8-bit assets render with correct lighting.

### Batching and Instancing

To handle hundreds of units on screen:

- `MeshBatchManager`, `MeshInstancingBatch`, `MeshMergingBatch`, `MergedSpriteMesh`, `BatchedMesh`, `InstancedMesh` group similar geometries.
- `SpriteUtils`, `CanvasSpriteBuilder`, `CanvasTextureAtlas` batch 2D sprites.
- `MapSpriteBatchLayer` batches map tile sprites.

### Camera and Viewport

- `Camera.ts` and `WorldViewportHelper.ts` manage the isometric camera.
- `CameraPan.ts` / `CameraZoom.ts` handle input-driven movement.
- `MapPanningHelper.ts` clamps panning to map bounds.
- `RaycastHelper.ts` and `EntityIntersectHelper.ts` convert mouse clicks into game-world targets.

### Lighting

- `Lighting.ts` and `LightingDirector.ts` compute the classic Westwood-style cell lighting.
- `LightingFx.ts`, `NukeLightingFx.ts`, `LightningStormFx.ts` handle special lighting events.
- `ExtraLightHelper.ts`, `BlobShadow.ts`, `ShadowRenderable.ts` add per-object shadows and highlights.

## 6. Audio

### AudioSystem (`src/engine/sound/AudioSystem.ts`)

- Web Audio API-based mixer.
- Supports positional 3D sound for in-world effects.
- Manages mute state when the tab is hidden.

### Sound, Music, EVA

- `Sound.ts` / `SoundSpecs.ts` — sound effect definitions and playback.
- `Music.ts` / `MusicSpecs.ts` — theme music playback.
- `Eva.ts` / `EvaSpecs.ts` — EVA announcements.
- `WorldSound.ts` — coordinates in-world sound emitters.
- `AudioLoop.ts`, `AudioSequence.ts` — loops and sequenced playback.

Sounds are loaded via the VFS as `WavFile` instances. Music is streamed asynchronously as `Mp3File`.

## 7. Performance and Debugging

- `src/performance/PerformanceOptions.ts` defines the base toggles (`raycastHelperReuse`, `entityIntersectTraversal`, `mapTileHitTest`, `worldViewportCache`, `worldSoundLoopCache`, `telemetry`), consumed by `src/performance/PerformanceRuntime.ts`.
- `ConsoleVars.ts` exposes the corresponding `perf*`-prefixed overrides (`perfRaycastHelperReuse`, `perfEntityIntersectTraversal`, `perfMapTileHitTest`, `perfWorldViewportCache`, `perfWorldSoundLoopCache`, `perfTelemetry`) plus other debug/cheat variables (free camera, force resolution, etc.).
- `DebugRenderable.ts`, `DebugLabel.ts`, `MapTileLayerDebug.ts` render debug overlays.
- `stats.js` overlay shows FPS / MS.

## 8. Mod Support

- Mods live in `mods/` under the RFS root.
- `Engine.setActiveMod(modName)` causes `loadMod()` in `GameRes` to overlay mod files on top of the base game.
- The `modHash` includes mod INIs so multiplayer clients can detect mismatches.

## Summary

The engine layer turns raw original game files into a running simulation and renderer:

1. **Import** assets into RFS / CDN.
2. **Layer** archives into the VFS.
3. **Load** rules and theaters into static `Engine` registries.
4. **Run** a fixed-tick simulation via `GameAnimationLoop` + turn manager.
5. **Render** each frame through `Renderer` → `WorldScene` → renderable builders.
6. **Play** audio through the Web Audio mixer.

The whole stack is deterministic and frame-rate-independent, which is the precondition for replay and lockstep multiplayer.
