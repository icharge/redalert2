import { describe, expect, test } from "bun:test";
import { GservServer, GservClient } from "../src/gserv/GservServer";
import { GservManager, GservInstance } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { FakeSocket } from "./helpers";
import { serializePlayerActions } from "../src/gserv/replay/gameoptCodec";

function buildGameOpts(names: string[]): string {
    const optionsPart = "0,0,0,10000,50,0,0,0,1,0,0,0,SXNsYW5kIFdhcg==,8,1,100,mpdefault,abc,1,0,0,1,0";
    const playersPart = names.map((name, i) => `${name},1,${i + 1},${i + 1},1,0,0,0`).join(",");
    return `${optionsPart}:${playersPart}:@:,-1,-1,-1,-1,`;
}

function buildRequestFrame(turnNo: number, payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(6 + payload.length);
    frame[0] = 2;
    frame[1] = 1;
    new DataView(frame.buffer).setUint32(2, turnNo, true);
    frame.set(payload, 6);
    return frame;
}

function setup() {
    const config = loadConfig({ GSERV_NET_RATE_MS: "33" });
    const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const server = new GservServer(config, manager);
    return { config, manager, server };
}

function join(server: GservServer, manager: GservManager, instance: GservInstance, nick: string): { socket: FakeSocket; client: GservClient } {
    const ticket = instance.tickets.get(nick)!;
    const socket = new FakeSocket();
    const client = server.handleOpen(socket);
    server.handleMessage(client, `ticket ${ticket}`);
    server.handleMessage(client, `join ${instance.gameId} 0.83 `);
    return { socket, client };
}

describe("GservManager lifecycle", () => {
    test("tickets are consumed when a player joins", () => {
        const { manager } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        const aliceTicket = instance.tickets.get("alice")!;
        expect(manager.validateTicket(aliceTicket)?.nick).toBe("alice");

        manager.consumeTicketByNick("alice");
        expect(manager.validateTicket(aliceTicket)).toBeUndefined();
        expect(manager.validateTicket(instance.tickets.get("bob")!)?.nick).toBe("bob");
    });

    test("instances and tickets are removed once the game ends", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice"]);
        const alice = join(server, manager, instance, "alice");
        server.handleMessage(alice.client, "loaded 100");

        // Game ended: solo player disconnects.
        server.handleClose(alice.client);
        expect(manager.get(instance.gameId)).toBeUndefined();
    });

    test("sweepExpired removes abandoned unstarted instances and their tickets", () => {
        const { manager } = setup();
        const abandoned = manager.create(["alice", "bob"], "ws://gserv");
        const started = manager.create(["carol"], "ws://gserv");
        started.started = true;
        const aliceTicket = abandoned.tickets.get("alice")!;

        const base = Math.floor(Date.now() / 1000);
        const removed = manager.sweepExpired(600, base + 601);

        expect(removed).toBe(1);
        expect(manager.get(abandoned.gameId)).toBeUndefined();
        expect(manager.get(started.gameId)).toBeDefined();
        expect(manager.validateTicket(aliceTicket)).toBeUndefined();
    });
});

describe("GservServer turn window", () => {
    test("accepts sequential turns but rejects stale and out-of-window turns", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);

        // A far-future turn number must be ignored (would otherwise grow
        // state.pending without bound).
        server.handleMessage(alice.client, buildRequestFrame(9999, noop));
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        server.handleMessage(bob.client, buildRequestFrame(0, noop));
        const frames = alice.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array);
        expect(frames.length).toBe(1);
        expect(new DataView(frames[0].buffer, frames[0].byteOffset, frames[0].byteLength).getUint32(2, true)).toBe(0);

        // Replaying an already-relayed turn must be ignored too.
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        server.handleMessage(bob.client, buildRequestFrame(0, noop));
        expect(alice.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length).toBe(1);
    });
});
