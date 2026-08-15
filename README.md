# RA2WEB React

**Disclaimer:** This project is developed based on the analysis of the Chinese version of *Chronodivide* — RA2WEB (www.ra2web.com), and is intended to be refactored using the latest versions of React and Three.js. All rights to this project, including profit rights, belong to the owner of *Chronodivide*. Without permission from the owner of *Chronodivide*, any commercial use of this project is strictly prohibited.

It should be noted that the owner of *Chronodivide* has never open-sourced the game client code in any form, even though some peripheral open-source content such as a mod-SDK exists. Bugs, incomplete functions, or other issues arising from the operation of this project shall not be regarded as damage to the reputation of *Chronodivide*. Any commercial activities conducted based on this project, including but not limited to placing advertisements, developing a "bullet-screen Red Alert" mode to profit from gifts, directly packaging and selling the project, or fraudulently obtaining sponsorship and donation revenue by claiming to be the "author", shall be deemed as infringement upon the original author of *Chronodivide*, Alexandru Ciucă, and RA2WEB.

A complete TypeScript re-implementation of the classic real-time strategy game *Red Alert 2*, built with React + TypeScript + Vite + Three.js.

![Animation](https://github.com/user-attachments/assets/d83f6001-d426-4d49-98a6-8282addc898d)

![image](https://github.com/user-attachments/assets/f146dc1c-ca15-456a-a8f0-4b43f2d431e8)

![image](https://github.com/user-attachments/assets/a23760df-e679-4b32-a9a2-ca51c214c420)

![image](https://github.com/user-attachments/assets/4781f451-7a51-45e2-919b-cbcb8bbd727a)

## Project Overview

This project is a game engine written in TypeScript that fully targets the *Red Alert 2* experience. After importing Red Alert 2 art assets locally, you can get a gameplay experience similar to the original Red Alert 2.

## Current Technical State

### Runtime and Build

- Package manager and local runtime: `Bun 1.3.10`
- Development server: `Vite 8.0.1`
- UI: `React 19.2.4` + `react-dom 19.2.4`
- Type system: `TypeScript 5.9.3`
- Rendering: `three 0.183.2`
- Automation: `Playwright 1.58.2`
- Default development and preview port: `127.0.0.1:4000`

## Quick Start

### Requirements

- `Bun 1.3+`
- A modern browser, Chrome / Edge recommended
- Browser must support:
  - `WebGL`
  - `Web Audio API`
  - `File System Access API`

### Install and Run

```bash
cd redalert2
bun install
bun run dev
```

Default address:

```text
http://127.0.0.1:4000
```

Production build and preview:

```bash
bun run build
bun run preview
```

Type checking:

```bash
bun run typecheck:entry
```

## Automated Regression

The repository no longer relies solely on manual verification. A set of directly executable regression scripts is maintained under `scripts/`, covering the lobby, map loading, mechanics, and tester entry points.

Common commands include:

```bash
bun run debug:game-res-init
bun run debug:viewport
bun run debug:options
bun run debug:storage-explorer
bun run debug:skirmish
bun run debug:skirmish-lobby-data
bun run debug:victory-exit
bun run debug:superweapon
bun run debug:nuke
bun run debug:radiation
bun run debug:minimap-shroud
bun run debug:anti-air-hit
bun run debug:terror-drone
bun run debug:chrono-legionnaire
bun run debug:test-entries
bun run debug:tester-panels
```

Output from these scripts is written to `.artifacts/` by default, making it easy to review screenshots and JSON results.

## Test Entry Points

The test entry points in the main menu are currently divided into three categories:

1. Asset tests
   - `VXL Test`
   - `SHP Test`
   - `Audio Test`
2. Mechanic tests
   - `Building Test`
   - `Vehicle Test`
   - `Infantry Test`
   - `Aircraft Test`
3. Scenario tests
   - `Lobby Test`
   - `World Test`
   - `Movement Test`

These tester pages are not isolated demos; they are important debugging and regression entry points in the current repository. The left-panel state on these pages syncs to the debug state object, and the automation scripts directly use these entry points to verify rendering and interaction results.

## Technical Architecture

### Core Technology Stack

- `React 19.2.4`
- `TypeScript 5.9.3`
- `Vite 8.0.1`
- `three 0.183.2`
- `Bun 1.3.10`
- `Playwright 1.58.2`
- `7z-wasm`
- `file-system-access`
- `@ffmpeg/ffmpeg`
- `@ra2web/pcxfile`
- `@ra2web/wavefile`

### Directory Structure

```text
redalert2/
├── public/          Static assets, configs, locales, legacy styles
├── scripts/         Playwright automated regression scripts
├── src/
│   ├── data/        Original resource formats, encoding, maps, VFS
│   ├── engine/      Rendering, audio, resource loading, low-level engine
│   ├── game/        Game logic, object system, triggers, rules, superweapons
│   ├── gui/         Main menu, HUD, options, in-game UI
│   ├── network/     Networking and multiplayer infrastructure
│   ├── tools/       Standalone tester pages
│   └── util/        Common utilities
├── server/          WOL lobby/channel + gserv match server (see server/README.md)
├── docs/            Alignment records and engineering notes
└── vite.config.ts   Development and build configuration
```

### Main Modules

`src/engine/`

- `gfx/`: Three.js rendering layer, materials, batching, viewport, lighting
- `renderable/`: Bridge between game objects and visible objects
- `sound/`: Audio mixing, music, sound effect playback
- `gameRes/`: Resource import, CDN loading, caching, and directory handling

`src/game/`

- `gameobject/`: Units, buildings, projectiles, traits, locomotors
- `rules/`: INI rule parsing and object rule construction
- `trigger/`: Map triggers, conditions, executors
- `superweapon/`: Nuke, Lightning Storm, Chrono, and other superweapon logic

`src/gui/`

- `screen/mainMenu/`: Main menu, map selection, lobby, options
- `screen/game/`: In-game HUD, world interaction, menus
- `component/`: React components
- `jsx/`: Custom UI rendering bridge

`src/tools/`

- Provides asset, mechanic, and scenario tester pages
- These are currently important entry points for debugging visualization and automated assertions

## Development Commands

```bash
bun run dev
bun run build
bun run preview
bun run typecheck:entry
```

## Documentation and Debugging Conventions

- Development port is fixed at `4000`
- Architecture and engine documentation is maintained under [`docs/`](docs/README.md)
- Automated output is written to `.artifacts/` by default
- A successful build does not mean all behavior is fully aligned; functional behavior should still be verified using the relevant scripts and actual workflows

## Contribution Guidelines

Before submitting changes, it is recommended to run at least:

```bash
bun run typecheck:entry
bun run build
```

If your changes involve the lobby, resource loading, map loading, HUD, mechanics, or testers, please also run the relevant `debug:*` scripts.

## License

This project is open-sourced under the GNU General Public License v3.0 (GPL-3.0). See the [LICENSE](LICENSE) file for details.

### Important Notes

- Free to use, modify, and distribute, unless permission is obtained from the RA2WEB responsible party; commercial use is strictly prohibited
- Copyright notice and license text must be retained
- Any derivative works must use the same GPL-3.0 license
- Source code must be provided, including modified versions
- GPL code may not be integrated into proprietary software

**Note:** This project is for learning and research purposes only. *Red Alert 2* is the intellectual property of EA. Please ensure you own a legitimate copy of the game when importing art assets.

## Acknowledgements

- RA2WEB.COM
- The Three.js community
- The React team
- The TypeScript team
- Maintainers of related open-source dependencies
- The Red Alert 2 player community

---

**Disclaimer:** This project is for learning and research purposes only, not for commercial use. *Red Alert 2* and related trademarks belong to EA.

---
