# WOL/IRC Legacy Status and Online Modernization Options

This document explains the current state of the Westwood Online (WOL) / IRC-style online infrastructure, why the login screen is present but not functional, and the practical paths for replacing or modernizing it with WebSocket-based services such as Colyseus.

## 1. What is WOL/IRC in this project?

The original *Command & Conquer: Red Alert 2* used **Westwood Online (WOL)** for internet multiplayer. WOL was IRC-like under the hood: players logged in with a nickname and password, joined lobby channels, created games, and relied on central services for matchmaking, ladder stats, and map transfers.

This codebase still **references** that legacy model:

- `src/gui/screen/mainMenu/login/LoginScreen.ts` — WOL authentication UI.
- `src/gui/screen/mainMenu/login/LoginBox.tsx` — region/nickname/password form.
- `src/gui/screen/mainMenu/login/ServerPings.ts` — region selection and ping logic.
- `public/servers.ini` — WOL/WebSocket endpoint configuration:
  ```ini
  [am-eu]
  label="Americas & Europe"
  wolUrl="wss://wol-eu1.chronodivide.com"
  apiRegUrl="https://wol-eu1.chronodivide.com/register"
  wladderUrl="https://wol-eu1.chronodivide.com/ladder"
  wgameresUrl="https://wol-eu1.chronodivide.com/wgameres"
  wolKeepAliveInGame=yes
  ```
- `src/network/WolConnection.ts`, `src/network/IrcConnection.ts`, `src/network/WolGameReport.ts` — legacy connection/report stubs.

However, the **actual implementation is missing or only stubbed** in this checkout.

## 2. Is the statement "using WOL/IRC protocol" true?

**Partially true in naming and intent, but false in the working implementation.**

| Area | Claim | Reality |
|------|-------|---------|
| UI labels / screens | WOL/IRC | True. The login, lobby, custom game, and quick-game screens all expect WOL-style services. |
| `servers.ini` | WOL endpoints | True. The INI still lists WebSocket and HTTP endpoints for WOL-style services. |
| `src/network/WolConnection.ts` | WOL connection | **False.** It only contains a constant (`MAX_ROOM_DESC_LEN = 64`). |
| `src/network/IrcConnection.ts` | IRC connection | **False.** It only defines error classes (`SocketError`, `NoReplyError`, `ConnectError`). |
| `WolService`, `WolError`, `WolConfig`, `WgameresService`, `MapTransferService` | Required services | **Missing files.** Referenced by screens but not in the source tree. |
| Working online multiplayer | WOL/IRC | **False.** The only working multiplayer is the LAN/WebRTC path in `src/network/lan/`. |

So the repository is in a **transition state**: the WOL/IRC interface is still visible, but the transport and services that would make it work are not implemented. The real network engine today is WebRTC-based peer-to-peer over local networks.

## 3. What is the login screen for?

`LoginScreen` is the intended entry point for **server-based online multiplayer**.

Its responsibilities are:

1. **Load server regions** from `servers.ini` via `wolService.loadServerList(this.serversUrl)`.
2. **Ping regions** to choose the best server.
3. **Validate the game version** against the selected region (`wolService.validateGameVersion(region)`).
4. **Authenticate** with a WOL/WebSocket server:
   ```ts
   this.wolService.connectAndLogin({
       url: region.wolUrl,
       user: username,
       pass: password
   }, onQueue)
   ```
5. **Configure service URLs** after a successful login:
   ```ts
   this.wladderService.setUrl(region.wladderUrl);
   this.wgameresService.setUrl(region.wgameresUrl);
   this.mapTransferService.setUrl(region.mapTransferUrl);
   ```
6. **Save credentials** and route the player to the main menu or lobby.

### Why it is currently dead code

The login screen is **not wired into the main menu**.

In `src/Gui.ts`, the `navigateToMainMenu()` method registers these sub-screens only:

```ts
Home, Skirmish, MapSelection, TestEntry, LanSetup,
InfoAndCredits, Credits, Options, OptionsSound, OptionsKeyboard,
ReplaySelection
```

`LoginScreen` is **not in that map**. Even if it were added, it would fail because its required services (`WolService`, `WladderService`, `WgameresService`, `MapTransferService`, `WolError`, `WolConfig`) do not exist in the source tree.

The login screen is therefore a **historical artifact** from the WOL/IRC design that is currently unreachable and non-functional.

## 4. How the working engine actually works

For a complete description of the working multiplayer stack, see [`networking.md`](networking.md) and [`online-play.md`](online-play.md). In short:

- **Transport:** WebRTC data channels (`src/network/lan/LanMeshSession.ts`).
- **Signaling:** QR-code SDP exchange (`src/network/lan/LanQrPayload.ts`).
- **Topology:** Full peer-to-peer mesh.
- **Lobby:** Host-authoritative room state (`src/network/lan/LanRoomSession.ts`).
- **Match:** Deterministic lockstep (`src/network/lan/LanMatchSession.ts` + `LanLockstepTurnManager.ts`).
- **NAT traversal:** None currently (`iceServers: []`). Only local networks work.

This is the **only working online path** today.

## 5. What is missing for true internet multiplayer?

| Missing piece | Why it matters |
|---|---|
| Real WOL/IRC/WebSocket service implementation | The login screen and lobby screens need a working backend. |
| Signaling server | WebRTC needs a way to exchange SDP between internet clients. |
| STUN/TURN servers | Current WebRTC uses no ICE servers; most players are behind NAT. |
| `gserv` game server connection | Server-relayed gameplay is not wired. |
| Map transfer service | Custom maps are currently transferred peer-to-peer only. |
| Login, lobby, matchmaking screens | They import missing WOL modules. |

## 6. Modernization options

### Option A: Keep WebRTC, add a signaling relay

The smallest change to get internet play working.

- Add a small **WebSocket signaling server** that relays SDP offers/answers and ICE candidates between clients.
- Add STUN/TURN configuration (e.g., Twilio, Cloudflare TURN, or self-hosted coturn).
- Keep `LanMeshSession`, `LanRoomSession`, and `LanMatchSession` mostly unchanged.
- Replace the QR-code handshake with WebSocket signaling while preserving it as a fallback for LAN.

**Pros:** Reuses the existing lockstep engine; minimal server cost.
**Cons:** Still a peer-to-peer mesh; player count is limited by bandwidth and NAT traversal.

### Option B: Port the room layer to Colyseus

Use Colyseus as the authoritative multiplayer server.

- Map `LanMeshSession` → Colyseus `Room` + WebSocket `Client`.
- Map `LanRoomState` → Colyseus `Schema` state.
- Map `LanRoomMessage` types → Colyseus room messages.
- Run lockstep turn resolution on the server or keep game traffic P2P while Colyseus owns the lobby.

**Pros:** Production-ready matchmaking, presence, state sync, and server authority.
**Cons:** Bigger architectural change; requires Node.js backend; binary action protocol must be carefully integrated.

### Option C: Hybrid — Colyseus for control plane, WebRTC for data plane

This is the recommended architecture for most RTS remakes.

- **Colyseus/WebSocket handles:**
  - Login / authentication
  - Lobby / room listing
  - Matchmaking
  - Chat
  - Custom map hosting
  - Initial WebRTC signaling
- **WebRTC data channels handle:**
  - Low-latency lockstep game traffic
  - Direct map transfer between peers

**Pros:** Combines server authority with the low latency of P2P.
**Cons:** Two protocols to maintain; signaling logic must be robust.

### Option D: Revive the WOL/IRC protocol over WebSocket

Implement the missing `WolService`, `IrcConnection`, `WolConfig`, `WgameresService`, `MapTransferService`, and `WolError` modules and connect to the endpoints already listed in `public/servers.ini`.

**Pros:** Matches the original game's community expectations and any existing community infrastructure.
**Cons:** Rebuilds a legacy protocol instead of using modern tooling; harder to maintain and scale.

## 7. Recommended path

If the goal is a modern, scalable online experience, use **Option C (hybrid)**:

1. **Keep** the proven WebRTC lockstep engine in `src/network/lan/`.
2. **Add** a WebSocket signaling server (can be a small Node/Cloudflare service, or Colyseus).
3. **Add** STUN/TURN for NAT traversal.
4. **Use Colyseus** (or equivalent) for login, lobby, matchmaking, chat, and room state.
5. **Replace** the WOL-specific logic in `LoginScreen` with modern auth and route into a Colyseus lobby.

This gives you the best of both worlds: server-authoritative control and the low latency of P2P game data.

## 8. File map

| File | Role |
|------|------|
| `src/gui/screen/mainMenu/login/LoginScreen.ts` | WOL login screen (dead code, not wired). |
| `src/gui/screen/mainMenu/login/LoginBox.tsx` | Login form UI. |
| `src/gui/screen/mainMenu/login/ServerPings.ts` | Region ping helper. |
| `src/gui/screen/mainMenu/login/ServerList.tsx` | Region list UI. |
| `src/gui/screen/mainMenu/lobby/LobbyScreen.ts` | WOL lobby (depends on missing services). |
| `src/gui/screen/mainMenu/customGame/CustomGameScreen.ts` | WOL custom game (depends on missing services). |
| `src/gui/screen/mainMenu/quickGame/QuickGameScreen.ts` | WOL quick match (depends on missing services). |
| `src/network/WolConnection.ts` | WOL stub (only a constant). |
| `src/network/IrcConnection.ts` | IRC stub (only error classes). |
| `src/network/WolGameReport.ts` | WOL-style game report decoder. |
| `public/servers.ini` | WOL/WebSocket endpoint configuration. |
| `src/network/lan/LanMeshSession.ts` | Working WebRTC mesh transport. |
| `src/network/lan/LanRoomSession.ts` | Working LAN room session. |
| `src/network/lan/LanMatchSession.ts` | Working lockstep match session. |
| `src/network/lan/LanLockstepTurnManager.ts` | Working lockstep turn manager. |
| `src/Gui.ts` | Wires LAN only; passes `undefined` for WOL services. |

## 9. Summary

- **WOL/IRC is referenced but not implemented.** The working engine is WebRTC LAN/P2P.
- **The login screen is the WOL authentication entry point, but it is not wired and cannot run** because its dependencies are missing.
- **For modern internet multiplayer**, the best path is a hybrid: WebSocket/Colyseus for login, lobby, and signaling; WebRTC for the low-latency lockstep game data.

For the details of the working lockstep engine, see [`networking.md`](networking.md) and [`online-play.md`](online-play.md).

---

## 10. Colyseus modernization plan (detailed)

This section is a concrete, file-level plan for adopting **Colyseus 0.17** as the control plane while preserving the existing WebRTC lockstep data plane. It is based on the current source tree and Colyseus documentation as of mid-2026.

### 10.1 Why Colyseus 0.17 is a good fit

Colyseus is an open-source Node.js multiplayer framework. The current stable release is **v0.17** (`@colyseus/core` up to `0.17.44`, `@colyseus/sdk` up to `0.17.43`).

Features that matter for this project:

- **WebSocket rooms with matchmaking** — one `Room` class can spawn many lobby instances.
- **Schema-based state synchronization** — authoritative server state is automatically patched to clients.
- **Built-in authentication hooks** — `onAuth()` / `static onAuth()` let you validate JWT tokens before a client joins a room.
- **Message handlers** — type-safe `messages = { ... }` with optional Zod validation.
- **Built-in rooms** — `LobbyRoom`, `QueueRoom`, and `RelayRoom` can be used as-is or extended.
- **Bun transport** — `@colyseus/bun-websockets` lets the server run on Bun, matching this project's existing Bun runtime.
- **Reconnection support** — `onDrop()` / `onReconnect()` (new in 0.17) handle transient disconnects cleanly.
- **Serverless export** — `serverless()` lets you deploy to Vercel-style platforms if needed.

### 10.2 High-level architecture after migration

```text
┌─────────────────────────────────────────────────────────────────┐
│  Client (browser)                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Colyseus    │  │ WebRTC      │  │ Game simulation         │  │
│  │ SDK client  │──│ data channel│──│ (lockstep)              │  │
│  └──────┬──────┘  └──────▲──────┘  └─────────────────────────┘  │
│         │                │                                      │
│         │  WebSocket     │  SDP signaling (via Colyseus room)   │
│         │  (auth/lobby/  │                                      │
│         │   room state)  │                                      │
└─────────┼────────────────┼──────────────────────────────────────┘
          │                │
          ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Colyseus server (Node/Bun)                                     │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Auth module / HTTP routes (JWT login, register, ladder)   │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  Matchmaking room  (room listing, create/join, chat)       │ │
│  │  - authoritative room state                                │ │
│  │  - slot/country/color/startPos/team assignment             │ │
│  │  - WebRTC signaling relay                                  │ │
│  │  - map download URLs                                       │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  Relay room (optional) — can relay WebRTC signaling only   │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Key principle: **Colyseus owns who is in the room and what the room state is; WebRTC still carries the lockstep action batches.**

### 10.3 Server-side files to create

Create a new top-level package or monorepo package, e.g. `packages/server/` or `server/`. Suggested layout:

```text
server/
├── package.json                  # colyseus, @colyseus/bun-websockets, zod
├── tsconfig.json
├── src/
│   ├── index.ts                  # Server entry point
│   ├── config.ts                 # Region config, JWT secret, TURN creds
│   ├── auth/
│   │   ├── AuthService.ts        # Login/register, JWT issue/verify
│   │   └── httpRoutes.ts         # Express/Hono routes for auth, ladder, maps
│   ├── rooms/
│   │   ├── MatchmakingRoom.ts    # Main lobby/custom-game room
│   │   ├── MatchmakingState.ts   # Colyseus Schema for room state
│   │   ├── SignalingMessages.ts  # WebRTC SDP/ICE message handlers
│   │   └── QueueRoom.ts          # Optional ranked queue
│   └── maps/
│       └── MapStorage.ts         # S3/R2-compatible map upload/download
```

#### `server/src/index.ts`

Bootstrap using Bun transport:

```ts
import { defineServer, defineRoom } from "colyseus";
import { bunWebSockets } from "@colyseus/bun-websockets";
import { MatchmakingRoom } from "./rooms/MatchmakingRoom";

const server = defineServer({
  transport: bunWebSockets({ /* Bun.serve options */ }),
  rooms: {
    matchmaking: defineRoom(MatchmakingRoom, { maxClients: 8 }),
  },
});

server.listen(2567);
```

#### `server/src/rooms/MatchmakingState.ts`

Map the existing `LanRoomState` to a Colyseus `Schema`.

```ts
import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

class Slot extends Schema {
  @type("string") type = "open";       // closed | open | player | ai | observer
  @type("string") peerId = "";
  @type("string") name = "";
  @type("uint8") countryId = 0;
  @type("uint8") colorId = 0;
  @type("uint8") startPos = 0;
  @type("uint8") teamId = 0;
  @type("boolean") ready = false;
}

class Member extends Schema {
  @type("string") peerId;
  @type("string") name;
  @type("boolean") isHost = false;
}

export class MatchmakingState extends Schema {
  @type("string") roomId: string;
  @type("string") hostPeerId: string;
  @type({ map: Member }) members = new MapSchema<Member>();
  @type([ Slot ]) slots = new ArraySchema<Slot>();
  @type("string") mapDigest = "";
  @type("string") mapDownloadUrl = "";
  @type("boolean") locked = false;
  @type("uint8") gameModeId = 0;
}
```

Notes:
- Keep `GameOpts` out of the synchronized schema unless it is small; prefer sending it as a one-time message when the game starts.
- Use `uint8` for enums to keep patches tiny.
- The schema is mutable; do not reassign `this.state`.

#### `server/src/rooms/MatchmakingRoom.ts`

```ts
import { Room, Client } from "colyseus";
import { MatchmakingState } from "./MatchmakingState";
import { signalingMessages } from "./SignalingMessages";

export class MatchmakingRoom extends Room<{
  state: MatchmakingState,
  client: Client<{ userData: { peerId: string; name: string } }>
}> {
  maxClients = 8;
  state = new MatchmakingState();

  messages = {
    // Reusable WebRTC signaling handlers
    ...signalingMessages,

    // Room-specific requests
    "slot-request": (client, payload) => {
      // Validate host or self; mutate this.state.slots; broadcast patch
    },
    "ready": (client, payload) => {
      // Toggle ready flag; check if all ready → host can start
    },
    "start-game": (client, payload) => {
      // Only host; build launch descriptor; broadcast to all clients
    },
  };

  static async onAuth(token: string, options: any, context: any) {
    // Verify JWT from AuthService
    return { userId: "...", name: options.name };
  }

  onCreate(options: any) {
    this.state.roomId = this.roomId;
    this.state.hostPeerId = options.hostPeerId;
  }

  onJoin(client, options: any, auth: any) {
    client.userData = { peerId: options.peerId, name: auth.name };
    this.state.members.set(client.sessionId, new Member().assign({
      peerId: options.peerId,
      name: auth.name,
      isHost: this.state.hostPeerId === options.peerId,
    }));
    // assign to next open slot
  }

  onLeave(client) {
    this.state.members.delete(client.sessionId);
    // free slot, migrate host if needed
  }

  onDrop(client) {
    // Optional: allowReconnection(client, 20) for ranked matches
  }
}
```

#### `server/src/rooms/SignalingMessages.ts`

Relay WebRTC offers/answers/ICE candidates between peers:

```ts
import { Messages } from "colyseus";
import { MatchmakingRoom } from "./MatchmakingRoom";

export const signalingMessages: Messages<MatchmakingRoom> = {
  "webrtc-offer": (client, { targetPeerId, description }) => {
    const target = [...this.clients].find(c => c.userData.peerId === targetPeerId);
    target?.send("webrtc-offer", {
      fromPeerId: client.userData.peerId,
      description,
    });
  },
  "webrtc-answer": (client, { targetPeerId, description }) => {
    // relay to target
  },
  "webrtc-ice": (client, { targetPeerId, candidate }) => {
    // relay ICE candidate to target
  },
};
```

This replaces the QR-code SDP exchange for internet play.

### 10.4 Client-side files to create

Add a new networking package under `src/network/colyseus/`:

```text
src/network/colyseus/
├── ColyseusAuthService.ts      # JWT login against server HTTP API
├── ColyseusClient.ts           # Thin wrapper around @colyseus/sdk
├── ColyseusRoomSession.ts      # Lobby/room logic adapter
├── ColyseusMatchSession.ts     # WebRTC lockstep adapter
├── WebRtcSignaling.ts          # Sends/receives SDP via Colyseus messages
└── index.ts
```

#### `src/network/colyseus/ColyseusRoomSession.ts`

Responsibilities:
- Connect to Colyseus matchmaking room.
- Subscribe to state changes and map them to the existing `LanRoomState` shape so the UI needs minimal changes.
- Send `slot-request`, `ready`, and `start-game` messages.
- Hand off WebRTC signaling to `WebRtcSignaling.ts`.

Pseudocode:

```ts
export class ColyseusRoomSession {
  private room: Room<MatchmakingState>;
  private mesh: LanMeshSession;

  async joinOrCreate(authToken: string, options: { name; peerId; region }) {
    const client = new Client(options.region.colyseusUrl);
    this.room = await client.joinOrCreate("matchmaking", options, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    this.room.state.slots.onChange(() => this.emitStateSync());
    this.room.state.members.onAdd(() => this.emitStateSync());
    this.room.state.members.onRemove(() => this.emitStateSync());

    this.room.onMessage("webrtc-offer", (msg) => this.mesh.handleRemoteOffer(msg));
    this.room.onMessage("webrtc-answer", (msg) => this.mesh.handleRemoteAnswer(msg));
    this.room.onMessage("webrtc-ice", (msg) => this.mesh.addIceCandidate(msg));
    this.room.onMessage("start-game", (descriptor) => this.onStartGame(descriptor));
  }

  requestSlot(slotIndex, countryId, colorId, startPos, teamId) {
    this.room.send("slot-request", { slotIndex, countryId, colorId, startPos, teamId });
  }

  setReady(ready: boolean) {
    this.room.send("ready", { ready });
  }

  startGame() {
    this.room.send("start-game", {});
  }
}
```

#### `src/network/colyseus/WebRtcSignaling.ts`

This bridges Colyseus messages and the existing `LanMeshSession`:

```ts
export class WebRtcSignaling {
  constructor(
    private room: Room<MatchmakingState>,
    private mesh: LanMeshSession,
  ) {
    // When mesh creates a local offer, send it through Colyseus
    mesh.onLocalOffer = (targetPeerId, description) => {
      this.room.send("webrtc-offer", { targetPeerId, description });
    };
    mesh.onLocalIceCandidate = (targetPeerId, candidate) => {
      this.room.send("webrtc-ice", { targetPeerId, candidate });
    };
  }
}
```

You may need to extend `LanMeshSession` so it can accept remote signaling inputs from a source other than QR codes.

### 10.5 Client-side files to modify

| Existing file | Change |
|---|---|
| `src/Gui.ts` | Register `LoginScreen` in the main menu sub-screens map; pass a `ColyseusAuthService` instance to `MainMenuRootScreen`. |
| `src/gui/screen/mainMenu/MainMenuRootScreen.ts` | Add a branch for `MainMenuScreenType.Login` that constructs `LoginScreen` with `ColyseusAuthService` and region config. |
| `src/gui/screen/mainMenu/login/LoginScreen.ts` | Replace WOL-specific `wolService` calls with `ColyseusAuthService`. After login, route to a new `OnlineLobbyScreen` or the existing LAN lobby adapted for Colyseus. |
| `src/gui/screen/mainMenu/login/LoginBox.tsx` | Keep the UI; just change the `onSubmit` contract to use the new auth service. |
| `src/gui/screen/mainMenu/lan/LanSetupScreen.ts` | Rename/generalize or add an `OnlineSetupScreen` that can use either `LanMeshSession` (QR mode) or `ColyseusRoomSession` (server mode). |
| `src/network/lan/LanMeshSession.ts` | Extract signaling interface: allow SDP/ICE to come from QR *or* from `WebRtcSignaling`. Keep the rest unchanged. |
| `src/network/lan/LanRoomSession.ts` | Abstract behind an interface so both LAN-only and Colyseus-backed modes share the same room API. |
| `src/network/lan/LanMatchSession.ts` | No changes needed if `LanMeshSession` is used for gameplay traffic. |
| `src/network/lan/LanQrPayload.ts` | Keep as fallback for pure LAN play. |
| `public/servers.ini` | Add `colyseusUrl` per region; keep `wolUrl` commented or removed. |

### 10.6 Suggested abstraction layer

Introduce an `OnlineRoomSession` interface so the UI does not care whether the backend is LAN QR or Colyseus:

```ts
export interface OnlineRoomSession {
  readonly roomId: string;
  readonly isHost: boolean;
  readonly state: Observable<RoomState>;
  readonly chat: Observable<ChatMessage>;

  requestSlot(...): void;
  setReady(ready: boolean): void;
  sendChat(text: string): void;
  startGame(): void;
  leave(): void;

  // Called by the match layer once the game starts
  getMatchTransport(): LanMeshSession;
}
```

Then implement:
- `QrRoomSession` — wraps `LanMeshSession` + `LanRoomSession`.
- `ColyseusRoomSession` — wraps Colyseus room + `LanMeshSession` for gameplay.

### 10.7 Data flow: from login to match

1. **Login**
   - `LoginBox` submits username/password.
   - `ColyseusAuthService.login()` POSTs to `https://server/api/auth/login`.
   - Server returns JWT + user profile.
   - `LoginScreen` saves token to `LocalPrefs` and routes to `OnlineLobbyScreen`.

2. **Lobby / room list**
   - `OnlineLobbyScreen` uses `ColyseusClient.getAvailableRooms("matchmaking")` to list rooms.
   - Or calls `client.joinOrCreate("matchmaking", { create: true, ... })` to host.

3. **Room**
   - Client joins Colyseus `MatchmakingRoom`.
   - Server `onAuth` validates JWT.
   - Server `onJoin` adds member/slot to `MatchmakingState`.
   - State patches propagate to all clients automatically.
   - Host mutates slots; clients send `slot-request` messages.

4. **WebRTC signaling**
   - Each peer generates peer ID and creates `RTCPeerConnection` with STUN/TURN.
   - Offers/answers/ICE are relayed through Colyseus messages.
   - Full mesh forms over internet.

5. **Map transfer**
   - Host uploads custom map to server storage (S3/R2) before starting.
   - Server puts `mapDownloadUrl` in `MatchmakingState`.
   - Non-host clients download via HTTP before sending `ready`.
   - Fallback: if all peers are already in a WebRTC mesh, transfer P2P via `LanRoomSession`.

6. **Start game**
   - Host clicks Start → `start-game` message.
   - Server validates all ready + map downloaded.
   - Server builds `OnlineLaunchDescriptor` and broadcasts it.
   - Clients create `Game` instance and `LanMatchSession` over existing mesh.

7. **In-game**
   - Lockstep action batches travel over WebRTC data channels exactly as they do today.
   - Colyseus room stays alive for chat/reconnection metadata but does not relay game actions.

### 10.8 Authentication details

Colyseus 0.17 supports three auth patterns:

- **Room `onAuth`** — validate a token per room join. Best for this project.
- **HTTP middleware** — protect matchmaking HTTP endpoints.
- **Auth module** — built-in username/password or OAuth flows.

Recommended: keep a small custom auth service:

```ts
// server/src/auth/AuthService.ts
export class AuthService {
  async login(username: string, pass: string) {
    // validate against DB; issue JWT
    return { token, user: { id, name } };
  }
  verifyToken(token: string) {
    // return decoded payload or throw
  }
}
```

The client stores the JWT in `LocalPrefs` and sends it via the `Authorization` header when joining rooms.

### 10.9 Reconnection and resiliency

Colyseus 0.17 added automatic reconnection:

```ts
async onDrop(client: Client) {
  // Keep slot reserved for 20 seconds
  await this.allowReconnection(client, 20);
}

onReconnect(client: Client) {
  // Mark player connected again
}
```

For RTS lockstep, you must still decide what to do if a peer misses too many ticks. The WebRTC `LanMatchSession` already has drop logic; Colyseus reconnection can restore the control-plane slot but cannot replay missed lockstep turns. The typical behavior:

- Short disconnect (< 5 s): peer reconnects and the control peer waits.
- Long disconnect: control peer marks the player as dropped; the player can rejoin as an observer or for the next match.

### 10.10 Deployment options

| Option | When to use |
|---|---|
| Self-hosted VPS + Bun | Cheapest; full control. |
| Colyseus Cloud | Managed hosting with monitoring and load balancing. |
| Serverless (Vercel) | Use `serverless()` export; good for auth/lobby but not ideal for long-lived game rooms. |

For RTS rooms, prefer a long-running server (VPS or Colyseus Cloud) because rooms are stateful and long-lived.

### 10.11 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Determinism broken by server-introduced state | Server should not influence simulation state; it only synchronizes lobby metadata and player assignments. |
| WebRTC still fails for some NATs | Provide STUN + TURN. If P2P cannot be established, fall back to a Colyseus `RelayRoom` for action relay (higher latency but functional). |
| Colyseus state patches too large | Keep `MatchmakingState` small; send `GameOpts` and map data as one-time messages, not schema fields. |
| Schema versioning | Add new fields at the end; mark removed fields `@deprecated()`. |
| Security | Validate all messages on the server; never trust client-sent slot changes for other players. |

### 10.12 Migration phases

A practical order to avoid a big-bang rewrite:

**Phase 1 — Server skeleton**
- Create `server/` package.
- Implement `AuthService`, HTTP login/register routes.
- Implement `MatchmakingRoom` with state and chat only.

**Phase 2 — Client login**
- Wire `LoginScreen` to the new auth service.
- Add `MainMenuScreenType.Login` and route to a simple room list.

**Phase 3 — Lobby over Colyseus**
- Build `ColyseusRoomSession`.
- Display slots, allow slot/ready changes, host start.
- Keep QR/LAN mode working in parallel.

**Phase 4 — WebRTC signaling over Colyseus**
- Add `WebRtcSignaling`.
- Extend `LanMeshSession` to accept remote signaling.
- Add STUN/TURN config.

**Phase 5 — Map hosting and transfer**
- Host custom maps on server storage.
- Download before match start.

**Phase 6 — Replace/remove WOL dead code**
- Delete or deprecate `WolConnection.ts`, `IrcConnection.ts`, and missing service imports.
- Remove `wolUrl` from `servers.ini`.

**Phase 7 — Hardening**
- Message validation, rate limiting, replay protection, ladder integration, ranked queue.

### 10.13 Summary of files

| New or modified | Purpose |
|---|---|
| `server/src/index.ts` | Bun + Colyseus bootstrap |
| `server/src/auth/AuthService.ts` | JWT login/register |
| `server/src/auth/httpRoutes.ts` | HTTP auth/ladder/map endpoints |
| `server/src/rooms/MatchmakingRoom.ts` | Main lobby room |
| `server/src/rooms/MatchmakingState.ts` | Synchronizable room state |
| `server/src/rooms/SignalingMessages.ts` | WebRTC SDP/ICE relay |
| `src/network/colyseus/ColyseusAuthService.ts` | Client auth API |
| `src/network/colyseus/ColyseusRoomSession.ts` | Colyseus lobby adapter |
| `src/network/colyseus/WebRtcSignaling.ts` | Signaling bridge |
| `src/network/lan/LanMeshSession.ts` | Modified to accept external signaling |
| `src/gui/screen/mainMenu/login/LoginScreen.ts` | Switched to Colyseus auth |
| `src/Gui.ts` | Wire login screen + auth service |
| `src/gui/screen/mainMenu/MainMenuRootScreen.ts` | Add login branch |

This plan keeps the existing lockstep engine intact while replacing the missing WOL/IRC infrastructure with a modern, maintainable Colyseus control plane.
