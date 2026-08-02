import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { server } from "../../src/app.ts";
import type { LobbyRoom } from "../../src/rooms/LobbyRoom.ts";

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("Timed out waiting for condition");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe("LobbyRoom", () => {
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

    it("adds a sanitized member on join and removes it on leave", async () => {
        const room = await colyseus.createRoom<LobbyRoom>("lobby", {});
        const client = await colyseus.connectTo(room, { name: "  Alice  " });

        expect(room.state.members.get(client.sessionId)?.name).toBe("Alice");

        await client.leave();
        await waitUntil(() => !room.state.members.has(client.sessionId));

        expect(room.state.members.has(client.sessionId)).toBe(false);
    });

    it("falls back to Guest for an empty or whitespace-only name", async () => {
        const room = await colyseus.createRoom<LobbyRoom>("lobby", {});
        const client = await colyseus.connectTo(room, { name: "   " });

        expect(room.state.members.get(client.sessionId)?.name).toBe("Guest");
    });

    it("shows multiple simultaneous members to each other", async () => {
        const room = await colyseus.createRoom<LobbyRoom>("lobby", {});
        const alice = await colyseus.connectTo(room, { name: "Alice" });
        const bob = await colyseus.connectTo(room, { name: "Bob" });

        expect(room.state.members.size).toBe(2);
        expect(room.state.members.get(alice.sessionId)?.name).toBe("Alice");
        expect(room.state.members.get(bob.sessionId)?.name).toBe("Bob");
    });

    it("broadcasts a chat message to everyone including the sender", async () => {
        const room = await colyseus.createRoom<LobbyRoom>("lobby", {});
        const alice = await colyseus.connectTo(room, { name: "Alice" });
        const bob = await colyseus.connectTo(room, { name: "Bob" });

        const bobMessage = bob.waitForMessage("chat", 2000);
        const aliceMessage = alice.waitForMessage("chat", 2000);
        alice.send("chat", { text: "hi" });

        const bobPayload = await bobMessage;
        const alicePayload = await aliceMessage;
        expect(bobPayload).toEqual({ name: "Alice", text: "hi", timestamp: expect.any(Number) });
        expect(alicePayload).toEqual({ name: "Alice", text: "hi", timestamp: expect.any(Number) });
    });

    it("drops a blank or whitespace-only chat message", async () => {
        const room = await colyseus.createRoom<LobbyRoom>("lobby", {});
        const alice = await colyseus.connectTo(room, { name: "Alice" });
        const bob = await colyseus.connectTo(room, { name: "Bob" });

        alice.send("chat", { text: "   " });

        await expect(bob.waitForMessage("chat", 200)).rejects.toThrow();
    });

    it("truncates an overly long chat message", async () => {
        const room = await colyseus.createRoom<LobbyRoom>("lobby", {});
        const alice = await colyseus.connectTo(room, { name: "Alice" });
        const bob = await colyseus.connectTo(room, { name: "Bob" });

        const longText = "x".repeat(500);
        const bobMessage = bob.waitForMessage("chat", 2000);
        alice.send("chat", { text: longText });

        const payload = await bobMessage;
        expect((payload as { text: string }).text.length).toBe(200);
    });

    it("lets a client rename themselves, visible to other members", async () => {
        const room = await colyseus.createRoom<LobbyRoom>("lobby", {});
        const alice = await colyseus.connectTo(room, { name: "Alice" });
        await colyseus.connectTo(room, { name: "Bob" });

        alice.send("rename", { name: "Alicia" });
        await waitUntil(() => room.state.members.get(alice.sessionId)?.name === "Alicia");

        expect(room.state.members.get(alice.sessionId)?.name).toBe("Alicia");
    });
});
