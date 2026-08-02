import { defineRoom, defineServer, matchMaker } from "@colyseus/core";
import { BunWebSockets } from "@colyseus/bun-websockets";
import { config } from "./config.ts";
import { MatchmakingRoom } from "./rooms/MatchmakingRoom.ts";

export const server = defineServer({
    transport: new BunWebSockets(),
    rooms: {
        matchmaking: defineRoom(MatchmakingRoom),
    },
    express: (app) => {
        app.get("/rooms", async (_req, res) => {
            const rooms = await matchMaker.query({ name: "matchmaking" });
            res.json(rooms.map((room) => ({
                roomId: room.roomId,
                clients: room.clients,
                maxClients: room.maxClients,
                metadata: room.metadata,
                locked: room.locked,
            })));
        });
        app.get("/ice-servers", (_req, res) => {
            res.json({ iceServers: config.iceServers });
        });
    },
});
