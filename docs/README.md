# RA2WEB React — Documentation

This folder contains architectural and technical documentation for the RA2WEB React project, a browser-based reimplementation of *Command & Conquer: Red Alert 2* written in TypeScript, React, and Three.js.

> **Scope:** The docs here are focused on how the codebase is organized, how the engine works, how networking and online play are implemented, and where the main seams are for future development. They are not user-facing setup guides; see the root [`README.md`](../README.md) for build and run instructions.

## Index

- [`overview.md`](overview.md) — What the project is, key design goals, and a high-level mental model.
- [`architecture.md`](architecture.md) — Directory layout, module boundaries, and data flow.
- [`engine.md`](engine.md) — Game engine: rendering, audio, asset loading, simulation loop, and VFS.
- [`networking.md`](networking.md) — Network architecture, protocols, and transport layer.
- [`online-play.md`](online-play.md) — LAN / online multiplayer room flow, lockstep sync, and map transfer.
- [`wol-irc-and-modernization.md`](wol-irc-and-modernization.md) — WOL/IRC client stack, the server, and options for modernizing online play.
- [`server-authoritative-experiment.md`](server-authoritative-experiment.md) — Investigation + implementation plan for a server-authoritative lockstep experiment (isolated sim mode).
- [`reconnection-improvements.md`](reconnection-improvements.md) — Proposed: instant pause UX on disconnect, rejoin catch-up progress bar, and fair kick/wait voting.
- [`ai-takeover-on-disconnect.md`](ai-takeover-on-disconnect.md) — Research only: feasibility of letting the skirmish AI pilot a disconnected player's army.
- [`csf-tool.md`](csf-tool.md) — The CSF CLI (`tools/csf.ts`): commands, the `.csf` binary format, and locale file workflows.
- [`viewport-resize-system.md`](viewport-resize-system.md) — Viewport/resize pipeline: why menu screens rerender on resize, and the desktop-flicker / mobile-keyboard fixes.
- [`../server/README.md`](../server/README.md) — The WOL lobby/channel + gserv match server.

## Quick Facts

| Concern | Technology |
|--------|------------|
| Runtime / bundler | Bun 1.3.10, Vite 8.0.1 |
| UI | React 19.2.4 |
| Language | TypeScript 5.9.3 |
| Renderer | Three.js 0.183.2 (WebGL) |
| Automation | Playwright 1.58.2 |
| Asset source | Local game files (File System Access API) or CDN |
| Multiplayer transport | WebRTC data channels (P2P, LAN) + WOL WebSocket server (internet lobby/match) |
| Lockstep model | Deterministic turn-based, command broadcast, host control peer |

## How to Keep These Docs Current

The docs are written against the current source tree. If you move, rename, or significantly refactor any of the following areas, update the relevant file:

- `src/engine/*` → `engine.md`
- `src/network/*` → `networking.md`, `online-play.md`, and `wol-irc-and-modernization.md`
- WOL/IRC login, lobby, or modernization changes → `wol-irc-and-modernization.md`
- `server/*` → `server/README.md`, `networking.md`, and `wol-irc-and-modernization.md`
- `src/game/*`, `src/gui/*`, `src/data/*` → `architecture.md` and `engine.md`
- Viewport / resize / fullscreen / mobile-layout changes → `viewport-resize-system.md`
- Build / entry flow changes → `overview.md`
- `tools/*` or `.csf` file / locale workflows → `csf-tool.md`

---

_Disclaimer: This project is for research and educational purposes. Red Alert 2 and related trademarks are property of Electronic Arts. The original Chronodivide / RA2WEB client code is not open source; this repository is an independent analysis and refactor._
