# Networking

This document describes the networking layer: what protocols and transports are used, how messages are serialized, and how the multiplayer infrastructure is organized.

## 1. Overview

RA2WEB React has **two online multiplayer paths**:

- **LAN / ad-hoc (P2P)** — rooms are formed directly between browsers using **WebRTC data channels**, signaled out-of-band via QR codes, and resolved with a deterministic **lockstep** simulation. No server is involved.
- **Internet lobby + match (WOL server)** — a server hosts the lobby, channels, chat, game listing, party, and quick-match queue, speaking the IRC-style Westwood Online protocol that the client implements in `src/network/WolConnection.ts`. Game setup data flows over that connection; in-match lockstep actions are relayed by a **gserv** match server (`src/network/GservConnection.ts`).

This document focuses on the LAN/P2P path. The WOL lobby/channel server is documented in [`../server/README.md`](../server/README.md) and summarized in [section 9](#9-wol-lobby-and-channel-server).

## 2. Transport: WebRTC Mesh

The core transport is implemented in `src/network/lan/LanMeshSession.ts`.

### Peer Connection Model

- Each peer creates an `RTCPeerConnection` with **no STUN/TURN servers** (`iceServers: []`). Connections are local-network only by design.
- A reliable, ordered `RTCDataChannel` (`ra2-lan-room`) carries all control and application messages.
- The topology is a **full mesh**: every peer maintains a direct data channel to every other peer.

### Identity

```ts
interface LanPeerIdentity {
    id: string;   // UUID
    name: string; // Display name
}
```

Each client generates its own peer ID and short room code. The host is the first peer in the room; host migration happens automatically if the host disconnects.

### Control Envelopes

All messages sent over data channels are JSON control envelopes with a `type` field:

| Type | Purpose |
|------|---------|
| `hello` | Sent on a new direct link; introduces self and known members |
| `room-sync` | Broadcasts the current member list |
| `member-join` | Notifies existing peers that a new member has joined |
| `member-leave` | Notifies that a member left or disconnected |
| `mesh-connect-request` | Asks two peers to complete their own direct link |
| `relay-signal` | Carries WebRTC offer/answer SDP between peers that cannot signal directly |
| `chat` | Room chat message |
| `app-message` | Opaque application payload (lobby state, game turns, load progress) |

### Room Lifecycle

1. Host calls `ensureLocalRoom()` and `createRoomInvite()`.
2. Host creates an SDP offer, waits for ICE gathering, and encodes it into a QR payload.
3. Joiner scans the QR code, calls `importPayload()`, creates an answer, and shows its own QR response.
4. Host scans the response and sets the remote description.
5. Data channel opens; host and joiner exchange `hello` and `room-sync`.
6. Host instructs existing peers to connect to the new member via `mesh-connect-request` + `relay-signal`.
7. The mesh converges when every pair of peers has a direct data channel.

### Snapshot

`LanMeshSession` exposes a reactive snapshot (`LanMeshSnapshot`) with:

- Self identity
- Room ID
- Member list with connection status (`self`, `known`, `connecting`, `connected`)
- Direct peer count
- Active QR payload (for UI rendering)

Consumers subscribe via `onSnapshotChange`.

## 3. Message Serialization

### Game Options and Slots

`src/network/gameopt/` contains the binary serialization used for lobby state and player actions.

- `Serializer.ts` — converts action records / game options into binary packets.
- `Parser.ts` — converts binary packets back into action records.
- `SlotInfo.ts` — slot metadata (player, AI, open, closed, observer).

Actions are serialized as:

```ts
{
    id: ActionType;     // numeric action identifier
    params: Uint8Array; // action-specific payload
}
```

The action factory (`src/game/action/`) creates concrete action instances from these records.

### Map Encoding

Custom map filenames and map names may use legacy encodings. `MapNameLegacyEncoder.ts` and `FileNameEncoder.ts` handle conversion between internal names and network-compatible strings.

## 4. HTTP Services

### HttpRequest (`src/network/HttpRequest.ts`)

- Thin wrapper around `fetch()` with progress callbacks and cancellation token support.
- Used by CDN resource loading, archive downloads, and ladder requests.

### Ladder (`src/network/ladder/`)

- `WLadderService.ts` communicates with a configured ladder backend.
- Supports player profiles, ranks, and ranked match history.
- Configuration comes from `config.ini` (`serversUrl`, ladder endpoints).

### Game Report (`src/network/WolGameReport.ts`)

- Small helper for reporting match outcomes to a Westwood Online-style service.
- `WolConnection.ts` / `IrcConnection.ts` are legacy-style connection stubs retained for compatibility.

## 5. Replay System

Replays are treated as a special kind of network source: a pre-recorded command stream played back through the same deterministic simulation.

### Components

- `Replay.ts` — replay file format and playback state.
- `ReplayRecorder.ts` — records local and network actions into a replay file.
- `ReplayTurnManager.ts` — drives the simulation from a replay.
- `SoloPlayTurnManager.ts` — local single-player / skirmish turn manager; can also be the basis for replay-less solo play.

### Replay File

A replay stores:

- Launch descriptor / game options
- Map digest
- Player assignments
- A per-tick list of serialized actions

Because the simulation is deterministic, replaying the exact action stream reproduces the exact game state and outcome.

## 6. Error Handling and Resilience

- WebRTC connection failures are logged and treated as disconnects.
- `LanMeshSession` broadcasts `member-leave` when a peer cleanly leaves; otherwise the data channel `connectionstatechange` handler marks the peer as disconnected.
- Higher layers (`LanRoomSession`, `LanMatchSession`) react to member changes by reallocating slots, migrating host, or dropping players from the lockstep turn.

## 7. Security Notes

- There is no authentication of peer identity beyond the QR-code handshake. Anyone who can scan the invite can join.
- All application messages are JSON over WebRTC data channels. There is no encryption layer beyond what the browser's DTLS provides for WebRTC.
- Custom map files are transferred peer-to-peer as base64 chunks and verified with a SHA-256-like digest (`MapDigest`).

## 8. Diagnostics

- `SdpCandidateDiagnostics.ts` summarizes ICE candidates in local descriptions.
- The mesh UI logs connection steps and warnings (e.g., "no host candidates found") to help users diagnose why two devices cannot connect.

## 9. WOL Lobby and Channel Server

The internet lobby path uses a server that reimplements the Westwood Online protocol the
client already speaks (`src/network/WolConnection.ts` + `IrcConnection.ts`). The
reference implementation lives in [`../server/`](../server/README.md).

### Roles

| Component | Client side | Server side |
|-----------|-------------|-------------|
| WOL meta server (lobby + channels) | `src/network/WolConnection.ts`, `IrcConnection.ts` | `server/src/server/WolServer.ts` |
| Account / session HTTP | `src/network/WolService.ts` (`apiLoginUrl`/`apiRegUrl`) | `server/src/http/routes.ts`, `server/src/auth/` |
| Match relay | `src/network/GservConnection.ts` | `server/src/gserv/GservServer.ts` |
| Party engine | `QuickGameScreen` party state | `server/src/server/PartyManager.ts` |
| Quick-match queue | `QuickGameScreen` + `matchbot` | `server/src/matchmaking/MatchmakingBot.ts` |

### Wire protocol

- Transport is line-based text over a `WebSocket` (`mode: "text"`), one command per
  line, `\r\n` terminated. Channel names are escaped with `IrcProtocol` on the wire.
- Session lifecycle: `cvers` → `setlocale`/`getlocale` → `session <token>` → MOTD block
  (`375`/`372`/`376`), or `378` (bad session) / `721` (server full). The login queue
  heartbeat is `720`.
- Lobby channels are `#Lob <channelType> 0` with the global password `zotclot9`
  (`WolConfig.GLOBAL_CHANNEL_PASS`). Joining yields a `JOIN` broadcast and `353`/`366`
  (`NAMES`) so the UI can render members immediately.
- Game channels are created with `joingame <name> <mode> <slots> <type> <obs> 0 <tourn> 0 [pass]`
  and listed via `LIST <type> <type>` (`321`/`322`/`323`); each listing carries the
  serialized topic (`Serializer.serializeTopic`) so the client can render map, slots,
  and mod info.
- Lobby state synchronizes through `GAMEOPT` messages (`A` ready, `K` has-map, `G` start
  request, `L` slots, `P` pings, `O` observer slot, `R` player options, or the full
  serialized options). The server relays them to every member except the sender (the
  client echoes its own locally).
- Game start: the host sends `startg <chan> <players>`; the server allocates a gserv
  instance + per-player ticket and sends `STARTG` to each player with
  `<gservUrl> <gameId> <timestamp> <ticket>`, or `STARTG_ABORT` with a reason.
- Party state is pushed to clients as `731` updates (`PARTY_UPDATE <id> <m1,m2>
  <idle|queued> <r1> <r2>`, plus `PARTY_INVITE`, `PARTY_FORMED`, `PARTY_LEFT`, …).

### gserv match relay

`GservConnection` connects to the `gservUrl` from `STARTG` and runs a small binary/text
protocol: `ticket`, `join <gameId> <timestamp> <ticket>`, `gameopts` (`500`), `loaded`,
`loadinfo` (`600`), `taunt` (`803`), `privmsg`, and binary turn-action frames (prefixed
`0x02`). The server relays each player's action frame to the other players in the
instance and signals `GAME_START` (`700`) once everyone has loaded.

### Protocol compatibility notes

The server must match the client's exact wire expectations, including:

- The leading `:` on every user-prefixed message (`JOIN`, `PRIVMSG`, `PART`, `KICK`,
  `GAMEOPT`, `MODE`, `TOPIC`, `JOINGAME`), which the client regexes require.
- `NAMES` entries shaped `[@]<nick>,<flag>,<ping>,<fresh>`; the game host is `@`.
- `LIST` replies with exactly 9 params so `reply.params[8]` is `<mode>::<topic>`.
- `PART` is echoed back to the leaving client; the client uses it to clean up its
  `currentChannels` set.

## Summary

| Concern | LAN/P2P path | Internet path (WOL server) |
|---------|--------------|-----------------------------|
| Transport | WebRTC data channels, full mesh | WebSocket, line-based IRC-style text |
| Signaling | QR-code SDP exchange | Server connection itself |
| Topology | Peer-to-peer, no server | Server-authoritative lobby + channel, gserv-relayed match |
| State sync | Deterministic lockstep | `GAMEOPT` relay / server state |
| Lobby messages | JSON control envelopes | IRC-style commands + numerics |
| Game actions | Binary `Serializer` / `Parser` | Binary turn-action relay via gserv |
| Auth | None | HTTP login/register + `session` token |
| Server | None | `server/` package (see `server/README.md`) |

For how rooms are formed, game options are synchronized, and the lockstep match is executed, see [`online-play.md`](online-play.md).
