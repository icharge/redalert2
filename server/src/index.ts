import { defineRoom, defineServer, matchMaker } from "@colyseus/core";
import { BunWebSockets } from "@colyseus/bun-websockets";
import { config } from "./config.ts";
import { MatchmakingRoom } from "./rooms/MatchmakingRoom.ts";

const transport = new BunWebSockets();

const server = defineServer({
    transport,
    rooms: {
        matchmaking: defineRoom(MatchmakingRoom),
    },
    express: (app) => {
        app.get("/rooms", async (_req, res) => {
            const rooms = await matchMaker.query({ name: "matchmaking", locked: false });
            res.json(rooms.map((room) => ({
                roomId: room.roomId,
                clients: room.clients,
                maxClients: room.maxClients,
                metadata: room.metadata,
            })));
        });
        app.get("/ice-servers", (_req, res) => {
            res.json({ iceServers: config.iceServers });
        });
    },
});

await server.listen(config.port);
console.log(`[server] listening on ws://localhost:${config.port}`);
