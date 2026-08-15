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

describe("GservServer rate limiting", () => {
    test("flooding is dropped when the limiter is enabled (default)", () => {
        const { server } = setup();
        const socket = new FakeSocket();
        const client = server.handleOpen(socket);
        // Each frame is capped at 32 lines, so exhaust the 600-token bucket
        // across many frames: the connection is dropped once it runs dry.
        for (let frame = 0; frame < 30; frame++) {
            server.handleMessage(client, Array.from({ length: 32 }, (_, i) => `ping ${frame}-${i}`).join("\n"));
        }
        expect(socket.readyState).toBe(3);
    });

    test("GSERV_RATE_LIMIT=disabled removes the limiter entirely", () => {
        const config = loadConfig({ GSERV_RATE_LIMIT: "disabled" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const socket = new FakeSocket();
        const client = server.handleOpen(socket);
        for (let frame = 0; frame < 30; frame++) {
            server.handleMessage(client, Array.from({ length: 32 }, (_, i) => `ping ${frame}-${i}`).join("\n"));
        }
        expect(socket.readyState).toBe(1);
        expect(client.rateBucket).toBeUndefined();
    });
});

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

    test("game does not start until every player has joined", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        server.handleMessage(alice.client, "loaded 100");

        // Partial roster: alice is at 100 but bob has not joined yet. The game
        // must not start, and bob's ticket must stay valid for his later login.
        expect(instance.started).toBe(false);
        expect(manager.validateTicket(instance.tickets.get("bob")!)?.nick).toBe("bob");
        const aliceLines = alice.socket.sent.filter((data): data is string => typeof data === "string").join("\n");
        expect(aliceLines).not.toContain(" 700 ");

        const bob = join(server, manager, instance, "bob");
        server.handleMessage(bob.client, "loaded 100");

        expect(instance.started).toBe(true);
        const bobLines = bob.socket.sent.filter((data): data is string => typeof data === "string").join("\n");
        expect(bobLines).toContain(" 802 ");
        expect(bobLines).toContain(" 700 ");
    });

    test("loading instance is aborted when a player disconnects before start", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");

        // Bob drops while the game is still loading: the game can never start,
        // so the remaining players must be bounced back instead of waiting on a
        // frozen loading screen.
        server.handleClose(bob.client);
        expect(alice.socket.readyState).toBe(3);
        expect(manager.get(instance.gameId)).toBeUndefined();
        expect(manager.validateTicket(instance.tickets.get("alice")!)).toBeUndefined();
    });

    test("abortStalledLoadingInstances aborts loading instances past the start timeout", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        server.handleMessage(alice.client, "loaded 100");

        // Bob never joins; after the start timeout the instance must abort.
        const base = instance.loadingSince!;
        const abortStalled = (server as any).abortStalledLoadingInstances.bind(server);
        expect(abortStalled(base + 10)).toBe(0);
        expect(manager.get(instance.gameId)).toBeDefined();

        expect(abortStalled(base + 190)).toBe(1);
        expect(alice.socket.readyState).toBe(3);
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

describe("GservServer per-instance stats logging", () => {
    test("stats line reports real frames/s and ticks/s per player", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        server.handleMessage(bob.client, buildRequestFrame(0, noop));
        server.handleMessage(alice.client, buildRequestFrame(1, noop));
        server.handleMessage(bob.client, buildRequestFrame(1, noop));

        // Two turns relayed, two frames per player, over a 1-second window.
        const buildStatsLines = (server as any).buildStatsLines.bind(server);
        const lines = buildStatsLines(Date.now() + 1000);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`instance ${instance.gameId}`);
        expect(lines[0]).toContain("2 player(s)");
        expect(lines[0]).toContain("2 ticks/s");
        expect(lines[0]).toContain("4 frames/s");
        expect(lines[0]).toContain("alice=2/s");
        expect(lines[0]).toContain("bob=2/s");
    });

    test("counters reset after each stats line", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice"]);
        const alice = join(server, manager, instance, "alice");
        server.handleMessage(alice.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        const buildStatsLines = (server as any).buildStatsLines.bind(server);

        const base = Date.now();
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        const first = buildStatsLines(base + 1000);
        expect(first[0]).toContain("1 ticks/s");

        // New window: stale counters must not leak into the next line.
        const second = buildStatsLines(base + 2000);
        expect(second[0]).toContain("0 ticks/s");
        expect(second[0]).toContain("0 frames/s");
        expect(second[0]).toContain("()");
    });
});
