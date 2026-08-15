# WOL/IRC Status and Online Architecture

This document explains the Westwood Online (WOL) / IRC-style online infrastructure in
this codebase: what is implemented on the client, what the server does, and what remains
as future work.

> **Status (current branch `feat/wol-lobby-server`):** the client-side WOL stack is fully
> implemented, and a reference WOL lobby/channel + gserv server now lives in
> [`server/`](../server/README.md). See [section 3](#3-what-is-implemented).

## 1. What is WOL/IRC in this project?

The original *Command & Conquer: Red Alert 2* used **Westwood Online (WOL)** for internet
multiplayer. WOL was IRC-like under the hood: players logged in with a nickname and
password, joined lobby channels, created games, and relied on central services for
matchmaking, ladder stats, and map transfers.

This codebase ports that model to the web:

- `src/gui/screen/mainMenu/login/` — WOL authentication UI (region/nickname/password).
- `public/servers.ini` — WOL/WebSocket endpoint configuration:
  ```ini
  [am-eu]
  label="Americas & Europe"
  available=yes
  gameVersion=0.65.1
  wolUrl="wss://wol-eu1.chronodivide.com"
  apiRegUrl="https://wol-eu1.chronodivide.com/register"
  wladderUrl="https://wol-eu1.chronodivide.com/ladder"
  wgameresUrl="https://wol-eu1.chronodivide.com/wgameres"
  wolKeepAliveInGame=yes
  ```
- `src/network/WolConnection.ts` — the IRC-style protocol client (session, channels,
  `NAMES`, `LIST`, `joingame`, `GAMEOPT`, `startg`, party).
- `src/network/IrcConnection.ts` — line-based WebSocket transport with
  command/reply matching.
- `src/network/GservConnection.ts` — the match-relay (gserv) client used after `STARTG`.
- `src/network/WolService.ts`, `WolConfig.ts`, `WolError.ts`, `WolGameReport.ts` — login,
  config, errors, and match reporting.

## 2. Client-side WOL stack

The client speaks a **line-based IRC dialect over a WebSocket** (`mode: "text"`). The
protocol is described in detail in [`networking.md`](networking.md#9-wol-lobby-and-channel-server)
and implemented server-side in [`server/src/server/WolServer.ts`](../server/src/server/WolServer.ts).

Highlights (with the authoritative client code):

| Area | Client file(s) |
|------|----------------|
| Login/session, MOTD, cvers, locale | `WolConnection.ts` (`authenticate`, `cvers`, `setLocale`) |
| Channels & chat | `WolConnection.ts` (`joinChannel`, `privmsg`, `listUsers`, `leaveChannel`) |
| Game browser | `CustomGameScreen.ts` (`LIST`) + `WolConnection.ts` (`listGames`) |
| Lobby/game channels | `LobbyScreen.ts` + `WolConnection.ts` (`createGame`, `joinGame`, `gameOpt`) |
| Game start | `WolConnection.ts` (`startGame` → `STARTG`), `GservConnection.ts` (gserv) |
| Party | `QuickGameScreen.ts` party state + `WolConnection.ts` (`partyInvite`, …) |
| Quick match | `QuickGameScreen.ts` + `matchbot` commands (`qmCodes.ts`) |

## 3. What is implemented

The `feat/wol-lobby-server` branch adds a working reference server that the client's WOL
screens can run against without client changes:

| Server component | Role |
|------------------|------|
| `server/src/server/WolServer.ts` | Lobby + channel command table (session, join/part/names, `LIST`, `joingame`, `gameopt` relay, `startg`) |
| `server/src/http/routes.ts` + `server/src/auth/` | `POST /login`, `POST /register`, session tokens |
| `server/src/server/PartyManager.ts` | Party engine (`PARTY_*` → `731` updates) |
| `server/src/matchmaking/MatchmakingBot.ts` | Quick-match queue + `matchbot` |
| `server/src/gserv/GservServer.ts` | Match relay (ticket/join/gameopts/action relay) |

The LAN/P2P path (`src/network/lan/`) is unchanged and remains the fully self-contained
local multiplayer option.

## 4. How the online engine works (WOL server path)

```text
Client (browser)
 ├── login/register  → HTTP  → /login /register → sessionToken
 ├── WolConnection   → WS    → / (lobby + channels)  ← WolServer
 │     ├── join "#Lob <type> 0" (password zotclot9)
 │     ├── LIST → game browser
 │     ├── joingame create/join → game channel
 │     ├── GAMEOPT relay ← lobby state sync
 │     └── startg → STARTG (gservUrl, gameId, timestamp, ticket)
 └── GservConnection → WS    → /gserv  ← GservServer
       ├── ticket + join <gameId> <timestamp> <ticket>
       ├── gameopts / loaded / loadinfo / taunt / privmsg
       └── binary turn-action relay between players
```

For full details see [`networking.md`](networking.md#9-wol-lobby-and-channel-server) and
[`server/README.md`](../server/README.md).

## 5. What is still missing / future work

| Area | Status |
|------|--------|
| Server persistence | Accounts/sessions are in-memory; needs a database for production. |
| Quick-match matchmaking | Functional stub (pairs 2 units, default `gameopts`); no real map selection, ranked pairing, or ladder. |
| gserv gameplay | Relays actions but does not simulate/validate; deterministic lockstep still runs on the clients. |
| Map transfer | Custom maps still transfer peer-to-peer; the WOL server does not host map files. |
| Ladder / game report | `wladderUrl` / `wgameresUrl` endpoints (`WolGameReport`) are not implemented. |
| TLS | The server is plain `ws://`; production needs `wss://` termination. |

## 6. Modernization options (reference)

If the goal is a fully managed, scalable online service (ladder, ranked queue, TURN
relay, hosted maps), the options are unchanged from the original analysis:

- **Option A — keep WebRTC, add a signaling relay + STUN/TURN** for the P2P mesh over
  the internet.
- **Option B — Colyseus as the control plane** (`MatchmakingRoom`), mapping lobby state
  to Colyseus `Schema`, with WebRTC or gserv for the data plane.
- **Option C (recommended for scale) — hybrid:** server-authoritative control plane
  (lobby/chat/matchmaking/maps) + low-latency data plane. The current WOL server already
  covers the control-plane role; a production build would swap the in-memory store for a
  database and add ladder/queue/turn infrastructure.
- **Option D — full WOL/IRC parity:** the current implementation; extend it with the
  missing services above.

## 7. File map

| File | Role |
|------|------|
| `src/network/WolConnection.ts` | IRC-style protocol client (client side) |
| `src/network/IrcConnection.ts` | Line-based WebSocket transport |
| `src/network/GservConnection.ts` | Match-relay client |
| `src/network/WolService.ts` | Login/session orchestration |
| `src/gui/screen/mainMenu/lobby/` | Custom-game browser + in-room lobby |
| `src/gui/screen/mainMenu/quickGame/` | Quick match + party UI |
| `server/src/server/WolServer.ts` | Server command table |
| `server/src/http/routes.ts` | HTTP login/register |
| `server/src/gserv/GservServer.ts` | Match relay |
| `server/README.md` | Server docs (run, config, protocol, tests) |

## 8. Summary

- **The WOL/IRC client stack is implemented** (`WolConnection` + `IrcConnection` +
  `GservConnection`).
- **A reference server now exists** in `server/` that speaks the same protocol: lobby +
  channels + game browser + lobby sync + party + quick match + gserv handoff.
- **The LAN/P2P WebRTC path is unchanged** and remains the offline/local option.
- **Remaining work** is production hardening (persistence, TLS, real matchmaking, map
  hosting, ladder), documented in [section 5](#5-what-is-still-missing--future-work).
