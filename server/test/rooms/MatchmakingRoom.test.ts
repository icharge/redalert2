import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { server } from "../../src/app.ts";
import type { MatchmakingRoom } from "../../src/rooms/MatchmakingRoom.ts";

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("Timed out waiting for condition");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe("MatchmakingRoom", () => {
    let colyseus: ColyseusTestServer;

    beforeAll(async () => {
        colyseus = await boot(server);
    });

    afterAll(async () => {
        await colyseus.shutdown();
    });

    beforeEach(async () => {
        await colyseus.cleanup();
    });

    it("defaults label from the host name and marks the room open", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });

        expect(room.metadata.label).toBe("Alice's game");
        expect(room.metadata.hostName).toBe("Alice");
        expect(room.metadata.mapOfficial).toBe(true);
        expect(room.metadata.passwordProtected).toBe(false);
        expect(room.state.hostPeerId).toBe("host-peer");
    });

    it("uses a custom label and flags the room as password protected", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
            label: "Alice's Arena",
            password: "secret",
        });

        expect(room.metadata.label).toBe("Alice's Arena");
        expect(room.metadata.passwordProtected).toBe(true);
    });

    it("treats a blank password as no password", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
            password: "   ",
        });

        expect(room.metadata.passwordProtected).toBe(false);

        // A blank/omitted password should be accepted without triggering onAuth's check.
        const client = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });
        expect(room.state.members.get(client.sessionId)?.peerId).toBe("guest-peer");
    });

    it("adds a member on join and removes it on leave", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const client = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });

        expect(room.state.members.get(client.sessionId)?.peerId).toBe("host-peer");
        expect(room.state.members.get(client.sessionId)?.name).toBe("Alice");

        await client.leave();
        await waitUntil(() => !room.state.members.has(client.sessionId));

        expect(room.state.members.has(client.sessionId)).toBe(false);
    });

    it("rejects a join with the wrong password", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
            password: "secret",
        });

        await expect(
            colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob", password: "wrong" })
        ).rejects.toThrow();
    });

    it("rejects a join with a missing password", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
            password: "secret",
        });

        await expect(
            colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" })
        ).rejects.toThrow();
    });

    it("accepts a join with the correct password", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
            password: "secret",
        });

        const client = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob", password: "secret" });
        expect(room.state.members.get(client.sessionId)?.peerId).toBe("guest-peer");
    });

    it("relays a webrtc-offer only to its targeted peer", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        host.send("webrtc-offer", {
            targetSessionId: guest.sessionId,
            description: { type: "offer", sdp: "v=0" },
        });

        const payload = await guest.waitForMessage("webrtc-offer");
        expect(payload.fromSessionId).toBe(host.sessionId);
        expect(payload.fromPeerId).toBe("host-peer");
        expect(payload.description).toEqual({ type: "offer", sdp: "v=0" });
    });

    it("relays a webrtc-answer back to the offering peer", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        guest.send("webrtc-answer", {
            targetSessionId: host.sessionId,
            description: { type: "answer", sdp: "v=1" },
        });

        const payload = await host.waitForMessage("webrtc-answer");
        expect(payload.fromSessionId).toBe(guest.sessionId);
        expect(payload.fromPeerId).toBe("guest-peer");
        expect(payload.description).toEqual({ type: "answer", sdp: "v=1" });
    });

    it("locks the room when the host signals game start", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });

        expect(room.locked).toBe(false);
        host.send("room-started");
        await room.waitForNextMessage();

        expect(room.locked).toBe(true);
    });
});
