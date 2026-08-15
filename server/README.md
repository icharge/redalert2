# RA2Web WOL Server

A Westwood Online (WOL)–compatible **lobby and channel server** for RA2Web. It speaks the
same IRC-style protocol that the game client implements in
`src/network/WolConnection.ts` / `IrcConnection.ts`, so the existing login, custom-game
browser, lobby, party, and quick-match screens can run against it without client changes.

The server also ships a minimal **gserv** match-relay endpoint so the `STARTG` handoff
(`GservConnection.ts`) works end to end.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (`bun --version`). The root repo already pins `bun@1.3.10`.

## Quick start

```sh
cd server
bun install          # install typescript + @types/bun (dev only)
bun run dev          # start the server on 127.0.0.1:9090
```

Background mode (Windows):

```sh
bun run dev:bg       # starts detached, logs to server.log
curl http://127.0.0.1:9090/health   # verify it is up
```

Verify with the unit tests and the three real-socket suites:

```sh
bun run typecheck    # strict TypeScript check
bun test             # unit tests (fake sockets)
bun run smoke        # smoke + two-player + gserv tests over real WebSockets
```

## Endpoints

| Endpoint | Type | Purpose |
|----------|------|---------|
| `POST /login` | HTTP | `{ locale, user, pass, turnstileToken }` → `{ user, sessionToken }` or `{ error, errorCode }`. Used by `WolService.login`. |
| `POST /register` | HTTP | Same body → creates account + session. Used by `WolService.createAccount`. |
| `GET /auth/session` | HTTP | Gateway auth check; returns `401` (no account) so the client falls back to the legacy login flow without error. |
| `GET /auth/csrf` | HTTP | `{ csrfToken }` for gateway-style POSTs. |
| `POST /auth/logout` | HTTP | `204` no-op logout. |
| `GET /servers.ini` | HTTP | Ready-to-use `servers.ini` pointing back at this server. |
| `GET /health` | HTTP | `{ status, accounts, sessions }`. |
| `/` (WebSocket) | WS | The WOL lobby/channel protocol (`wolUrl`). |
| `/gserv` (WebSocket) | WS | The match-relay protocol (`GservConnection`). |

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `SERVER_HOST` | `0.0.0.0` | Bind address. |
| `SERVER_PORT` | `9090` | Port. |
| `EXTERNAL_URL` | `ws://127.0.0.1:9090` | Public WOL URL; also the base for `/servers.ini` and the gserv URL handed out in `STARTG`. |
| `GAME_VERSION` | `0.83.2` | Accepted game version (major.minor matched for quick-match). |
| `GLOBAL_CHANNEL_PASS` | `zotclot9` | Password for `#Lob <type> 0` lobby channels (`WolConfig.GLOBAL_CHANNEL_PASS`). |
| `MATCH_BOT_NAME` | `matchbot` | Quick-match bot nick (`WolConfig.MATCH_BOT_NAME`). |
| `SERVER_MOTD` | welcome text | MOTD lines, `\n`-separated. |
| `SESSION_TTL_SECONDS` | `86400` | Session token lifetime. |
| `EXPECTED_MOD_HASH` | *(none)* | When set, quick-match rejects mismatched mod hashes (`Badhash`). |
| `MIN/MAX_USERNAME_LENGTH` | `2` / `15` | Account username limits (mirror `WolConfig`). |
| `MIN/MAX_PASSWORD_LENGTH` | `8` / `128` | Account password limits (mirror `WolConfig`). |
| `FRESH_ACCOUNT_AGE_SECONDS` | `86400` | Accounts younger than this are "fresh" (cannot invite to a party). |
| `GSERV_URL_PATH` | `/gserv` | Path of the match-relay endpoint. |
| `GSERV_ID` | `gs1` | gserv id reported in `GSERV` messages. |
| `WOL_URL_PATH` | *(empty)* | Extra path suffix for the WOL WebSocket URL reported in `/servers.ini` (e.g. `/wol` behind a reverse proxy). The server accepts the WOL protocol on any path that is not `GSERV_URL_PATH`. |
| `PING_INTERVAL_SECONDS` | `30` | Server→client `PING` interval (measures player pings). |
| `STORAGE` | `sqlite` | Storage backend for accounts/sessions: `sqlite` or `memory`. |
| `DB_PATH` | `server/data/ra2web.sqlite` | SQLite database file; `:memory:` uses an in-memory SQLite DB. |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed browser origins for the HTTP endpoints **and** WebSocket upgrades. With a specific list, matching origins are echoed back with `Access-Control-Allow-Credentials: true` and other origins (including WebSocket handshakes) are rejected with `403`. |

## Pointing the game client at it

Point the client's server list at this server. Either:

1. In `public/config.ini` set `serversUrl` to `http://127.0.0.1:9090/servers.ini`, or
2. Edit a local `servers.ini` with:

```ini
[local]
label="Local Dev"
available=yes
gameVersion=0.83.2
wolUrl="ws://127.0.0.1:9090"
apiLoginUrl="http://127.0.0.1:9090/login"
apiRegUrl="http://127.0.0.1:9090/register"
```

`wolUrl` is used as-is by `IrcConnection` (`new WebSocket(url)`), so it must include the
`ws://`/`wss://` scheme. From an `http://` dev origin, `ws://` works; from an `https://`
origin you need TLS (terminate `wss://` in front of the server).

## Reverse proxy (nginx)

A ready-to-adapt config lives in [`nginx.conf`](nginx.conf) that terminates TLS,
proxies the WebSocket endpoints, and serves the built client (produce it with
`bun run build:dist`):

```sh
cd server && SERVER_HOST=127.0.0.1 \
  EXTERNAL_URL=wss://service.thaira2.com \
  WOL_URL_PATH=/wol \
  CORS_ALLOWED_ORIGINS=https://service.thaira2.com \
  bun run dev
```

- `EXTERNAL_URL` is the public `wss://` base; the server uses it for the gserv URL in
  `STARTG` and to generate `/servers.ini`.
- `WOL_URL_PATH=/wol` places the WOL WebSocket at `wss://service.thaira2.com/wol`, so the
  static root can serve the client without conflicting with the `/` location.
- Point the client's `config.ini` `serversUrl` at `https://service.thaira2.com/servers.ini`.

`/cdn/*` paths in the client config are **not** served by this server or the sample
nginx config; add locations for them (or an existing CDN) as needed.

## Cross-origin (CORS)

The HTTP endpoints and WebSocket endpoints send CORS headers so the client can run from
a different origin (e.g. the Vite dev server on `http://localhost:5173`).

- Default (`CORS_ALLOWED_ORIGINS=*`): the request's `Origin` is echoed back with
  `Access-Control-Allow-Credentials: true`. The client's `AuthService`/`RealmService`
  use `credentials: "include"`, which browsers reject with a wildcard
  `Access-Control-Allow-Origin`, so echoing the origin is required. The server never
  sets cookies, so no ambient credentials are exposed.
- Restricted (e.g. `CORS_ALLOWED_ORIGINS=https://service.thaira2.com`): only listed origins
  are echoed with credentials; unknown origins get no `Access-Control-Allow-Origin` on
  HTTP and are rejected with `403` on WebSocket upgrades. Use this in production.

Preflight (`OPTIONS`) is handled for `Content-Type` and `X-CSRF-Token` request headers
(the CSRF header the client's realm auth flow uses). Responses include `Vary: Origin`.

## Protocol summary

Transport is line-based text over WebSocket, one command per line, terminated with
`\r\n`. The client implementation is the authoritative reference
(`src/network/WolConnection.ts`). The server implements the exact wire formats the
client's regexes expect, including the leading `:` on user-prefixed messages.

Client→server commands handled by `WolServer`:

| Command | Purpose |
|---------|---------|
| `PING`/`PONG` | Heartbeat / ping measurement. |
| `cvers <ver> <sku>` | Version check → `700`/`701`. |
| `setlocale <n>` / `getlocale <nick>` | Locale → `310` / `309`. |
| `session <token>` | Session login → MOTD block (`375`/`372`/`376`) or `378`. |
| `join <chan> [pass]` | Join a lobby channel (auto-creates `#Lob <type> 0`, password `zotclot9`) → `JOIN` + `353`/`366`. |
| `PART <chan>` | Leave a channel. |
| `NAMES <chan>` | User list → `353`/`366`. |
| `LIST <id> <id>` | Game list → `321` + `322` (`<mode>::<topic>`) + `323`. |
| `privmsg <t1,t2> :<text>` | Channel chat / whispers / quick-match bot messages. |
| `kick <chan> <users> :<reason>` | Kick users (operator only). |
| `joingame <chan> <mode> <slots> <type> <obs> 0 <tourn> 0 [pass]` | Create a game channel. |
| `joingame <chan> <tourn> [pass]` | Join a game channel. |
| `gameopt <chan> :<opt>` | Relay lobby options (`A/K/G/L/P/O/R` or full serialized options). |
| `MODE <chan> +l <n>` | Set channel user limit. |
| `topic <chan> :<topic>` | Store + broadcast game topic (serialized `WolGameTopic`). |
| `gping <chan> <player> <ms>` | Report player ping. |
| `startg <chan> p1,p2` | Allocate a gserv instance and send `STARTG` to each player. |
| `PARTY_*` | Party engine (`INVITE/ACCEPT/DECLINE/LEAVE/PREVENT/STATUS/NOINVITES/INVITE_UNAVAILABLE`) → `731` updates. |

Server→client pushes: `JOIN`, `JOINGAME`, `PRIVMSG`, `PART`, `KICK`, `GAMEOPT`, `MODE`,
`TOPIC`, `STARTG`, `STARTG_ABORT`, `GSERV`, and numeric replies (`353`, `366`, `321`,
`322`, `323`, `700`, `720`, `730`, `731`, …).

The gserv endpoint implements the `GservConnection` protocol: `cvers`, `ticket`,
`join`, `gameopts`, `loaded`, `loadinfo`, `active`, `taunt`, `privmsg`, and binary
turn-action relay (frames prefixed with `0x02`).

## Layout

```text
server/
├── src/
│   ├── index.ts                 # Bun.serve wiring: WS (wol/gserv) + HTTP routes
│   ├── config.ts                # Env config
│   ├── protocol/                # lineCodec (channel name escape), numeric codes, replies
│   ├── auth/                    # AccountStore, SessionManager
│   ├── http/routes.ts           # /login /register /servers.ini /health
│   ├── server/                  # WolServer command table, ServerUser, Channel/GameChannel, PartyManager
│   ├── matchmaking/             # MatchmakingBot (quick-match queue)
│   └── gserv/                   # GservManager (instance/ticket allocation), GservServer (relay)
├── scripts/
│   ├── wolLib.ts                # Shared real-WebSocket test client
│   ├── wol-smoke-client.ts      # Single-player protocol smoke test
│   ├── wol-two-player.ts        # Two-player lobby/game/chat/startg test
│   └── wol-gserv-test.ts        # STARTG -> gserv handoff test
├── test/                        # Unit tests (bun:test, fake sockets)
├── package.json
└── tsconfig.json
```

## Storage

Accounts and sessions are persisted through a pluggable `Storage` backend
(`server/src/storage/`). Implement the `Storage` interface and register it in
`createStorage` to add a backend.

| Backend | `STORAGE` | Notes |
|---------|-----------|-------|
| SQLite | `sqlite` (default) | File-backed (`DB_PATH`), survives restarts; `bun:sqlite` + WAL. |
| In-memory | `memory` | Resets on restart; useful for tests / ephemeral dev. |

Passwords are hashed with `Bun.password.hash` (never stored in plaintext).

## Known limitations / roadmap

- Accounts/sessions are persisted via SQLite; lobby state (channels, games, parties)
  is still in-memory and resets on restart.
- Quick-match builds a **default gameopts** (no map selection or real map transfer) and
  pairs 2 units per queue type; ranked/ladder integration is not implemented.
- The gserv relays turn actions but performs no simulation or validation (as the client
  uses server-relay mode this is a functional stub for the control path).
- Private (`pass-locked`) games are created and joinable by name/password but, matching
  the client's `LIST` mode filter, do not appear in the game browser.
- `docs/networking.md` and `docs/wol-irc-and-modernization.md` describe the client side
  and how this server plugs into the overall networking story.
