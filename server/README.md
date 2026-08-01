# Online play server

Thin Colyseus control plane for online play: room discovery (browsable list),
membership, and WebRTC signaling relay. It does not run or validate any game
logic — lobby state (slots/ready/map), and the game itself, stay entirely
peer-to-peer between clients (see `src/network/lan/` in the main client repo).

## Run

```bash
bun install
bun run dev
```

Listens on `ws://localhost:2567` by default (override with `PORT`).
A plain `GET /rooms` HTTP endpoint lists open rooms for the client's
browsable room list.

## Env vars

- `PORT` — listen port (default `2567`)
- `ICE_SERVERS` — comma-separated list of STUN/TURN URLs handed to clients
  for WebRTC (default: Google's public STUN server)
