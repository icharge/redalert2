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

    it("rejects a duplicate room name", async () => {
        await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
            label: "Alice's Arena",
        });

        await expect(
            colyseus.createRoom<MatchmakingRoom>("matchmaking", {
                peerId: "other-host-peer",
                name: "Carol",
                label: "Alice's Arena",
            })
        ).rejects.toThrow();
    });

    it("rejects a join with a player name already taken in the room", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });

        await expect(
            colyseus.connectTo(room, { peerId: "guest-peer", name: "Alice" })
        ).rejects.toThrow();
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

    it("lets the host lock and unlock the room", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });

        host.send("lock-room");
        await waitUntil(() => room.state.locked === true);
        expect(room.locked).toBe(true);

        host.send("unlock-room");
        await waitUntil(() => room.state.locked === false);
        expect(room.locked).toBe(false);
    });

    it("ignores a lock-room request from a non-host client", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        guest.send("lock-room");
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(room.state.locked).toBe(false);
        expect(room.locked).toBe(false);
    });

    it("closes the room for everyone when the host leaves on purpose without transferring", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        // Register the listener before triggering the leave — a consented
        // leave broadcasts host-lost synchronously server-side, so awaiting
        // host.leave() first can miss it.
        const hostLost = guest.waitForMessage("host-lost", 2000);
        await host.leave(); // consented — the default
        await hostLost;
    });

    it("lets the host transfer ownership to another member", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        expect(room.metadata.label).toBe("Alice's game");

        host.send("transfer-host", { targetSessionId: guest.sessionId });
        await waitUntil(() => room.state.hostPeerId === "guest-peer");

        expect(room.state.hostPeerId).toBe("guest-peer");
        expect(room.metadata.label).toBe("Bob's game");
    });

    it("does not rename a room whose label was customized at creation", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
            label: "Epic Battle",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        host.send("transfer-host", { targetSessionId: guest.sessionId });
        await waitUntil(() => room.state.hostPeerId === "guest-peer");

        expect(room.metadata.label).toBe("Epic Battle");
    });

    it("does not close the room when the former host leaves after transferring ownership", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        host.send("transfer-host", { targetSessionId: guest.sessionId });
        await waitUntil(() => room.state.hostPeerId === "guest-peer");

        await host.leave();
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(room.state.members.has(guest.sessionId)).toBe(true);
        expect(room.state.hostPeerId).toBe("guest-peer");
    });

    it("ignores a transfer-host request from a non-host client", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });
        const guest2 = await colyseus.connectTo(room, { peerId: "guest2-peer", name: "Carol" });

        guest.send("transfer-host", { targetSessionId: guest2.sessionId });
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(room.state.hostPeerId).toBe("host-peer");
    });

    it("keeps a disconnected host's seat and identity if they reconnect within the grace window", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const hostSessionId = host.sessionId;
        const reconnectionToken = host.reconnectionToken;

        await host.leave(false); // simulates an involuntary disconnect, not a consented leave
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Still held open during the grace window — not evicted immediately.
        expect(room.state.members.has(hostSessionId)).toBe(true);

        const reconnectedHost = await colyseus.sdk.reconnect(reconnectionToken);
        expect(reconnectedHost.sessionId).toBe(hostSessionId);
        expect(room.state.members.has(hostSessionId)).toBe(true);
        expect(room.state.hostPeerId).toBe("host-peer");

        await reconnectedHost.leave();
    });

    it("closes the room and notifies remaining members if the host never reconnects", async () => {
        const room = await colyseus.createRoom<MatchmakingRoom>("matchmaking", {
            peerId: "host-peer",
            name: "Alice",
        });
        const host = await colyseus.connectTo(room, { peerId: "host-peer", name: "Alice" });
        const guest = await colyseus.connectTo(room, { peerId: "guest-peer", name: "Bob" });

        await host.leave(false);
        await guest.waitForMessage("host-lost", 15000);
    }, 20000);
});
