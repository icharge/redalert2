# Project Overview

RA2WEB React is a complete browser-based reimplementation of *Command & Conquer: Red Alert 2* (and *Yuri's Revenge*) written in TypeScript, React, and Three.js. The project is developed as an analysis and refactor of the Chinese RA2WEB (Chronodivide) web client, with the explicit goal of modernizing the stack while keeping gameplay fidelity.

> **Important:** This project is **not** the official open-sourced RA2WEB/Chronodivide client. It is an independent, educational refactor. All commercial rights remain with the original RA2WEB owner. See the root [`README.md`](../README.md) and [`LICENSE`](../LICENSE) for the full legal disclaimers.

## What It Does

After the user provides a valid copy of the original Red Alert 2 game assets (locally or via CDN), the application can:

1. Load and parse the original `.mix`, `.shp`, `.vxl`, `.hva`, `.tmp`, `.pal`, `.wav`, `.mp3`, `.ini`, and `.map` files.
2. Render the isometric battlefield, units, buildings, terrain, shroud, and effects using Three.js/WebGL.
3. Run the original game logic: construction, locomotion, combat, super weapons, AI, triggers, and map objectives.
4. Provide a React-based UI matching the classic menu flow: main menu, map selection, options, lobby, in-game HUD, and replay viewer.
5. Support local skirmish, AI opponents, and LAN / P2P multiplayer over WebRTC.
6. Record and play back replays using the deterministic lockstep system.

## Key Design Goals

- **Fidelity first:** Behaviors, stats, and object rules come from the original INI files (`rules.ini`, `art.ini`, `ai.ini`, etc.) plus custom overrides (`rulescd.ini`, `artcd.ini`).
- **Web-native:** Runs entirely in a modern browser using WebGL, Web Audio, File System Access API, and WebRTC.
- **Modular engine:** The renderer, simulation, and UI are separate layers joined by narrow interfaces.
- **Deterministic multiplayer:** Lockstep synchronization with deterministic simulation, replay-compatible command streams, and host control-peer resolution.
- **Modern tooling:** Vite for dev/build, React for UI, Playwright for automated regression, Bun for runtime/package management.

## High-Level Mental Model

```text
┌─────────────────────────────────────────────────────────────┐
│                         GUI (React)                          │
│  Menus, HUD, Lobby, Options, Test Pages, Replay UI          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       Application.ts                         │
│  Bootstraps config, translations, viewport, routing, GameRes  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        GameRes Engine                        │
│  VFS / RFS / Mix loading, CDN fallback, asset import/caching │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         Engine.ts                            │
│  Static registries for INI, SHP, VXL, HVA, TMP, palettes,    │
│  sounds, theaters, map list, mod hash.                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Game.ts                               │
│  Simulation: objects, players, AI, triggers, rules, map.    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   WorldScene / Renderables                   │
│  Three.js scenes, sprites, voxels, lighting, effects,        │
│  minimap, viewport, camera.                                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        AudioSystem                           │
│  Sound effects, EVA announcements, music, mixing.            │
└─────────────────────────────────────────────────────────────┘
```

## Entry Flow

1. `index.html` loads the Vite bundle.
2. `src/main.tsx` mounts the React `App` component and registers built-in bots.
3. `App.tsx` creates an `Application` instance and calls `Application.main()` once `#ra2web-root` is available.
4. `Application.main()` loads:
   - `config.ini` (servers, locale, viewport defaults)
   - `ra2/general.csf` and JSON locale files
   - Game resources via `GameRes` (VFS + RFS or CDN)
   - `rules.ini` / `rulescd.ini`, `art.ini` / `artcd.ini`, `ai.ini`
5. After resources are ready, `initRouting()` starts the URL-based screen router (`Routing`) and the GUI (`Gui`).
6. Test routes (`/vxltest`, `/worldscenetest`, `/lobbytest`, etc.) are loaded on demand and are used as regression entry points.

## Resource Sources

There are two supported modes for obtaining original game assets:

- **Local / RFS:** Uses the browser File System Access API or IndexedDB fallback. The user selects the game directory once; files are imported and cached. This is the primary path for local development.
- **CDN:** A `GameResConfig` can point at a remote base URL. The CDN loader fetches a manifest and resources over HTTP. This is mainly used for hosted deployments.

The `Engine` class exposes static lazy resource collections (`Engine.images`, `Engine.voxels`, `Engine.sounds`, etc.) that abstract whether the underlying file came from a `.mix` archive, a local file, or a CDN request.

## Multiplayer Modes

- **Local Skirmish:** One human player vs. AI on the local machine.
- **LAN / P2P:** WebRTC mesh room created via QR-code invites. The room session synchronizes game options, slots, custom map transfer, and readiness. Once launched, the match uses deterministic lockstep with turn-based command synchronization.
- **Replays:** Single-player deterministic playback of recorded command streams.

## Test and Regression

The `scripts/` folder contains Playwright-based regression flows for key features (lobby, map loading, units, superweapons, LAN mesh, etc.). Many flows drive the test pages under `src/tools/` rather than the production menu, so they double as both debugging and regression entry points.

## Common Terminology

| Term | Meaning |
|------|---------|
| `RFS` | Real File System — browser file handles or IndexedDB adapter |
| `VFS` | Virtual File System — layered archive search over RFS, Mix files, BAG files, and in-memory archives |
| `Mix` | Westwood archive format used by the original game |
| `SHP` | Sprite animation format |
| `VXL` | Voxel model format for vehicles / infantry |
| `HVA` | Voxel animation format paired with VXL |
| `TMP` | Isometric tile / terrain format |
| `Theater` | Tileset/theme (Temperate, Snow, Urban, NewUrban, Desert, Lunar) |
| `Lockstep` | Multiplayer model where all clients execute the same command stream per tick |
| `Turn / Tick` | The fixed simulation step (e.g., 60 ticks per second) used by the game loop |
