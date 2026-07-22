# Networking

This document describes the networking layer: what protocols and transports are used, how messages are serialized, and how the multiplayer infrastructure is organized.

## 1. Overview

RA2WEB React uses a **peer-to-peer (P2P)** networking model for multiplayer. There is no dedicated game server in the LAN/P2P path. Instead:

- Rooms are formed directly between browsers using **WebRTC data channels**.
- Signaling is done out-of-band via **QR codes** scanned by another device.
- Within a match, the game runs a **deterministic lockstep** simulation. All peers submit commands for each tick; the match resolves a turn only after receiving commands from every active peer.

This design means:

- No server infrastructure is required for LAN or local ad-hoc play.
- NAT traversal relies on local network connectivity (the current implementation uses host candidates only; see below).
- All game state stays on the clients.

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

## Summary

| Concern | Implementation |
|---------|----------------|
| Transport | WebRTC data channels, full mesh |
| Signaling | QR-code SDP exchange |
| Topology | Peer-to-peer, no server |
| State sync | Deterministic lockstep (see `online-play.md`) |
| Lobby messages | JSON control envelopes |
| Game actions | Binary `Serializer` / `Parser` |
| Offline replay | Recorded action stream + `ReplayTurnManager` |
| HTTP services | CDN resources, ladder, game report |

For how rooms are formed, game options are synchronized, and the lockstep match is executed, see [`online-play.md`](online-play.md).
