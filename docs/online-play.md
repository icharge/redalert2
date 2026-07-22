# Online Play

This document explains the end-to-end multiplayer flow: creating a room, synchronizing game options, transferring custom maps, launching the match, and staying in lockstep.

## 1. Multiplayer Model

RA2WEB React implements **deterministic lockstep multiplayer** over a **WebRTC peer-to-peer mesh**.

Key properties:

- The simulation is deterministic: given the same initial state and the same ordered action stream, every client reaches the same state.
- Only **player commands** (orders, production, superweapon targeting, etc.) are sent over the network, not unit positions or health.
- The game advances one tick at a time and only processes a tick once it has received the command batch for that tick from every active peer.
- This guarantees synchronization but means all clients wait for the slowest peer each tick.

## 2. Room Phase (`LanRoomSession`)

Before the match starts, players gather in a room managed by `src/network/lan/LanRoomSession.ts`.

### Room State

```ts
interface LanRoomState {
    version: 1;
    hostPeerId: string;
    memberOrder: string[];
    humanAssignments: LanHumanAssignment[];
    gameOpts: GameOpts;
    slotsInfo: SlotInfo[];
    readyStateByPeerId: Record<string, boolean>;
    mapTransferStateByPeerId: Record<string, LanMapTransferPeerState>;
}
```

The host owns the authoritative room state. Non-host clients send requests to the host; the host applies them and broadcasts a `state-sync`.

### Room Messages

| Type | Direction | Purpose |
|------|-----------|---------|
| `state-sync` | Host → all | Full room state broadcast |
| `slot-request` | Client → host | Change country/color/start/team for a slot |
| `ready` | Client → host | Toggle ready status |
| `map-offer` | Host → client | Begin custom map transfer |
| `map-chunk` | Host → client | Chunk of base64 map data |
| `map-complete` | Client → host | Confirm map received / report error |
| `start-game` | Host → all | Launch the match |
| `host-handover` | Host → all | Migrate host before leaving |

### Slot Assignment

When members join or leave, `LanRoomSession.syncHumanAssignments()`:

1. Removes assignments for departed members.
2. Assigns new members to the next available player slot.
3. Fills remaining open slots with AI if configured.
4. Keeps observer slots separate.

### Custom Map Transfer

Custom maps are not pre-installed; they must be distributed to all peers before the match can start.

1. Host computes `MapDigest.compute(file)` and stores the digest in `gameOpts.mapDigest`.
2. When a non-host peer joins, `scheduleCustomMapTransfers()` begins sending the map.
3. The host sends `map-offer` followed by sequential `map-chunk` messages (12 KB base64 chunks).
4. The client reassembles chunks, verifies the digest, persists the file to its own `maps/` directory, and replies with `map-complete`.
5. `canStart()` returns false until every member reports `complete`.

Official maps skip transfer because every client is assumed to have them.

### Host Migration

If the host disconnects:

1. The host (before leaving) broadcasts `host-handover` to the next peer in `memberOrder`.
2. If the host leaves uncleanly, each remaining peer runs `reconcileRoomStateWithMesh()` and the first remaining member becomes host.
3. The new host takes over state broadcasts and map transfers.

## 3. Launch Phase (`LanLaunchDescriptor`)

When the host clicks Start, `LanRoomSession.startGame()` builds a `LanLaunchDescriptor`:

```ts
interface LanLaunchDescriptor {
    kind: 'lan';
    roomId: string;
    gameId: string;
    timestamp: number;
    hostPeerId: string;
    localPeerId: string;     // filled in by each receiver
    localPlayerName: string; // filled in by each receiver
    gameOpts: GameOpts;
    humanAssignments: LanHumanAssignment[];
    mapTransferStateByPeerId: Record<string, LanMapTransferPeerState>;
    returnRoute: { screenType: number; params?: any };
}
```

The descriptor is broadcast via `start-game`. Each client then:

1. Loads the selected map and theater.
2. Initializes the local `Game` instance with matching `gameOpts` and player assignments.
3. Creates a `LanMatchSession` over the existing `LanMeshSession` transport.
4. Waits for all peers to report 100% load progress before starting the lockstep loop.

## 4. Match Phase (`LanMatchSession`)

Once in-game, `src/network/lan/LanMatchSession.ts` handles the lockstep command exchange.

### Turn Batches

For each tick, every peer produces a **turn batch**:

```ts
interface LanMatchTurnBatch {
    tick: number;
    peerId: string;
    turnId: string;
    actionData: Uint8Array;
    dropPeerIds: string[];
    receivedAt: number;
}
```

The `actionData` is the binary serialized local player actions for that tick. If the player did nothing, a `NoAction` is still sent so peers can advance.

### Control Peer

The **control peer** is the first active, non-dropped peer in assignment order. The control peer's turn batch carries the authoritative `dropPeerIds` list for that tick. This avoids conflicting drop decisions:

```ts
private getControlPeerId(): string {
    const orderedActivePeerIds = this.getOrderedActivePeerIds();
    const availableControlPeers = orderedActivePeerIds.filter((peerId) => !suspectedDropPeerIds.has(peerId));
    return availableControlPeers[0] ?? orderedActivePeerIds[0] ?? selfId;
}
```

### Resolving a Turn

`tryConsumeTurn(tick)` returns a `LanResolvedTurn` only when:

1. The turn batch for the control peer has arrived.
2. All expected peers (active peers minus control-peer drops) have submitted a batch.

If any peer is missing, the match waits. This waiting state is surfaced as a "lag" indicator.

### Handling Disconnects

- If a peer drops from the mesh, `handleSnapshotChange()` adds the peer to `suspectedDropPeerIds`.
- If the local peer is the control peer, it refreshes its previously submitted turns with the updated `dropPeerIds` and re-broadcasts them.
- Once the control peer resolves the turn, the dropped peer is removed from `activePeerIds` and will no longer be expected for future ticks.

### Load Progress Synchronization

During map/game loading, peers broadcast `lan-game-load-progress` messages. `LanMatchSession.areAllPlayersLoaded()` returns true only when every active peer reaches 100%. The game loop starts only after that.

## 5. Lockstep Turn Manager (`LanLockstepTurnManager`)

`src/network/lan/LanLockstepTurnManager.ts` connects the generic `GameAnimationLoop` to the match session.

Per tick:

```ts
doGameTurn(_timestamp) {
    const tick = this.game.currentTick;

    // 1. Submit local actions once per tick
    const localTurnId = this.submitLocalTurn(tick);

    // 2. Wait until the match has resolved this tick
    const resolvedTurn = this.matchSession.tryConsumeTurn(tick);
    if (!resolvedTurn) {
        this.updateLagState(true, tick);
        return false; // animation loop will try again next frame
    }

    // 3. Apply every peer's actions
    this.processResolvedTurn(tick, resolvedTurn);

    // 4. Advance the simulation
    this.game.update();
    return true;
}
```

`processResolvedTurn`:

1. Parses each peer's `actionData` with `Parser`.
2. Creates the corresponding `Action` via `actionFactory`.
3. Sets `action.player` to the player matching the peer assignment.
4. Calls `action.process()`.
5. Records drop-player actions for any peer dropped in this turn.

## 6. Action System (`src/game/action/`)

Player inputs are converted to action instances that implement:

```ts
interface Action {
    actionType: ActionType;
    player: Player;
    serialize(): Uint8Array;
    unserialize(data: Uint8Array): void;
    process(): void;
    print?(): string; // debug string
}
```

Examples:

- `OrderUnitsAction` — move, attack, guard, and other per-unit orders (covers move/attack, not separate classes per order type).
- `PlaceBuildingAction` — place a completed building on the map.
- `ActivateSuperWeaponAction` — fire a superweapon.
- `UpdateQueueAction` — queue/cancel production items.
- `NoAction` — empty turn placeholder.

Actions are queued by the local input system and dequeued by the turn manager. For multiplayer they are serialized and broadcast; for solo play they are applied directly.

## 7. Determinism Guarantees

Lockstep only works if every client produces identical simulation results. The project enforces determinism through:

- **Fixed-point math** and shared PRNG (`src/game/Prng.ts`) seeded with `gameId` and `startTimestamp`.
- **No floating-point in simulation state** that affects outcomes (visual interpolation is separate).
- **Same rule database** — all clients load the same `rules.ini`/`rulescd.ini` and compute the same `modHash`.
- **Same action order** — the control peer defines drop sets, and actions are processed in assignment order.
- **Same initial state** — derived from the same map file and `gameOpts`.

## 8. Lag and Pause Behavior

- If a peer does not submit a turn in time, the game stalls for all peers until the turn arrives or the peer is dropped.
- When the browser tab is hidden, non-observer players switch to a background interval so they continue submitting turns.
- `setPassiveMode(true)` tells the match session that the local client is running in the background.

## 9. Replay from Multiplayer

The same action stream used for multiplayer can be recorded by `ReplayRecorder`. The replay stores:

- The launch descriptor
- Map digest
- Per-tick action batches

Playback uses `ReplayTurnManager`, which feeds actions into `Game.update()` exactly as if they had arrived over the network.

## 10. Debugging Multiplayer

Useful debug flows in `package.json`:

| Script | Purpose |
|--------|---------|
| `debug:lan-mesh` | Mesh creation and peer connection |
| `debug:lan-app-message` | Application message passing |
| `debug:lan-entry` | LAN lobby entry screenshot |
| `debug:lan-lockstep` | Lockstep turn synchronization |
| `debug:lan-match-session` | Full match session flow |
| `debug:lan-map-transfer` | Custom map transfer |

## Summary

```text
Room Phase (LanRoomSession)
  ├── WebRTC mesh via QR codes (LanMeshSession)
  ├── Game options / slots synchronized by host
  ├── Custom map transferred if needed
  └── Host clicks Start

Launch Phase
  ├── LanLaunchDescriptor broadcast to all peers
  ├── Each client loads the same map + theater
  └── LanMatchSession created

Match Phase (LanMatchSession + LanLockstepTurnManager)
  ├── Each tick: local actions serialized and broadcast
  ├── Control peer decides drop set
  ├── Tick resolves when all expected batches arrive
  ├── Actions applied, simulation advances
  └── Disconnects handled by dropping peer from active set
```

The result is a serverless, deterministic multiplayer experience faithful to classic RTS networking, implemented entirely in the browser.
