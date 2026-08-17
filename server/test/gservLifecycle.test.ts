import { describe, expect, test } from "bun:test";
import { GservServer, GservClient } from "../src/gserv/GservServer";
import { GservManager, GservInstance } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { FakeSocket } from "./helpers";
import { serializePlayerActions, parseAllPlayerActions } from "../src/gserv/replay/gameoptCodec";

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

    test("instances are retired on game end and removed after the report window", () => {
        const { config, manager, server } = setup();
        const instance = manager.create(["alice"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice"]);
        const alice = join(server, manager, instance, "alice");
        server.handleMessage(alice.client, "loaded 100");

        // Game ended: solo player disconnects. The rejoin window opens; once it
        // expires with nobody left, the instance is retired (endedAt set) so
        // the game-res report can still be validated, and is removed once the
        // report window closes.
        server.handleClose(alice.client);
        const retained = manager.get(instance.gameId);
        expect(retained).toBeDefined();
        expect(retained!.endedAt).toBeUndefined();
        const graceMs = config.reconnectGraceSeconds * 1000;
        server.runSweepPass(Date.now() + graceMs + 1);
        const retired = manager.get(instance.gameId);
        expect(retired).toBeDefined();
        expect(retired!.endedAt).toBeDefined();

        const base = Math.floor(Date.now() / 1000);
        expect(manager.sweepExpired(600, 600, base + 601)).toBe(1);
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

    test("loading instance is aborted when a player disconnects before start and never rejoins", () => {
        const { config, manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");

        // Bob drops while the game is still loading. A rejoin grace window
        // opens instead of an instant abort, so alice is NOT bounced yet.
        server.handleClose(bob.client);
        expect(alice.socket.readyState).toBe(1);
        expect(manager.get(instance.gameId)).toBeDefined();
        expect(instance.loadingDepartures.has("bob")).toBe(true);

        // Within the window bob can rejoin with the same ticket.
        const bobRejoin = join(server, manager, instance, "bob");
        expect(instance.loadingDepartures.has("bob")).toBe(false);
        expect(bobRejoin.client.instance).toBe(instance);

        // Bob drops again and never comes back: once the grace window expires
        // the remaining players are bounced instead of waiting forever.
        server.handleClose(bobRejoin.client);
        server.runSweepPass(Date.now() + (config.loadingDepartureGraceSeconds + 1) * 1000);
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
        const removed = manager.sweepExpired(600, 600, base + 601);

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

    test("passive player (active 0) is no longer required for turn relay", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        const countBinary = (socket: FakeSocket) => socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length;

        // Both players submit turn 0, then bob resigns and becomes an
        // observer: the server must stop waiting for bob's submissions.
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        server.handleMessage(bob.client, buildRequestFrame(0, noop));
        const relayedAfterTurn0 = countBinary(alice.socket);
        expect(relayedAfterTurn0).toBe(1);

        server.handleMessage(bob.client, "active 0");
        server.handleMessage(alice.client, buildRequestFrame(1, noop));

        // Without the fix the server would keep waiting for bob's turn 1 and
        // never relay; with it, alice's turn 1 is relayed immediately.
        expect(countBinary(alice.socket)).toBe(2);
    });
});

describe("GservServer loading screen info", () => {
    test("loadinfo reports the full roster with connected status, and pushes on join", () => {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob", "carol"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob", "carol"]);
        const alice = join(server, manager, instance, "alice");

        server.handleMessage(alice.client, "loadinfo");
        let aliceLines = alice.socket.sent.filter((data): data is string => typeof data === "string").join("\n");
        const firstLoadInfo = aliceLines.split("\n").filter((line) => line.includes(" 600 ")).at(-1);
        expect(firstLoadInfo).toContain("alice,1,0,0,0,0");
        expect(firstLoadInfo).toContain("bob,0,0,0,0,0");
        expect(firstLoadInfo).toContain("carol,0,0,0,0,0");

        // When bob joins, every already-connected member is pushed an updated
        // loadinfo so the loading screen does not sit on stale data.
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(bob.client, "loaded 42");
        aliceLines = alice.socket.sent.filter((data): data is string => typeof data === "string").join("\n");
        const pushedLoadInfo = aliceLines.split("\n").filter((line) => line.includes(" 600 ")).at(-1);
        expect(pushedLoadInfo).toContain("bob,1,42,0,0,0");
    });
});

describe("GservServer mid-game reconnect", () => {
    const noop = () => serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
    const countBinary = (socket: FakeSocket) => socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length;

    function startGame() {
        const { config, manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        return { config, manager, server, instance, alice, bob };
    }

    test("mid-game drop opens a rejoin window that holds the relay until rejoin", () => {
        const { manager, server, instance, alice, bob } = startGame();
        expect(instance.started).toBe(true);

        // Turn 0 relays normally.
        server.handleMessage(alice.client, buildRequestFrame(0, noop()));
        server.handleMessage(bob.client, buildRequestFrame(0, noop()));
        expect(countBinary(alice.socket)).toBe(1);

        // Bob drops: the relay must hold (no backfill), others are notified.
        server.handleClose(bob.client);
        const aliceLines = alice.socket.lines().join("\n");
        expect(aliceLines).toContain(" 806 ");
        server.handleMessage(alice.client, buildRequestFrame(1, noop()));
        expect(countBinary(alice.socket)).toBe(1);

        // Bob rejoins with the same ticket: resync log + resume.
        const bobRejoin = join(server, manager, instance, "bob");
        const bobLines = bobRejoin.socket.lines().join("\n");
        expect(bobLines).toContain(" 701 ");
        const resyncFrames = bobRejoin.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array);
        expect(resyncFrames.length).toBe(1);
        expect(new DataView(resyncFrames[0].buffer, resyncFrames[0].byteOffset, resyncFrames[0].byteLength).getUint32(2, true)).toBe(0);

        // Bob signals ready; the relay resumes once both submit turn 1.
        server.handleMessage(bobRejoin.client, "ready 0");
        server.handleMessage(bobRejoin.client, buildRequestFrame(1, noop()));
        expect(countBinary(alice.socket)).toBe(2);
        expect(countBinary(bobRejoin.socket)).toBe(2);
        expect(alice.socket.lines().join("\n")).toContain(" 807 ");
    });

    test("mid-game rejoin window expiry backfills the player and play resumes", () => {
        const { config, server, alice, bob } = startGame();
        server.handleMessage(alice.client, buildRequestFrame(0, noop()));
        server.handleMessage(bob.client, buildRequestFrame(0, noop()));
        expect(countBinary(alice.socket)).toBe(1);

        server.handleClose(bob.client);
        server.handleMessage(alice.client, buildRequestFrame(1, noop()));
        expect(countBinary(alice.socket)).toBe(1);

        server.runSweepPass(Date.now() + config.reconnectGraceSeconds * 1000 + 1);
        expect(countBinary(alice.socket)).toBe(2);
        expect(alice.socket.lines().join("\n")).toContain(" 808 ");
    });

    test("tickets stay valid after start so a departed player can re-login", () => {
        const { manager, server, instance, alice } = startGame();
        expect(manager.validateTicket(instance.tickets.get("bob")!)?.nick).toBe("bob");
        server.handleClose(alice.client);
        const rejoin = join(server, manager, instance, "bob");
        expect(rejoin.client.instance).toBe(instance);
    });

    test("resync log covers every relayed turn in order", () => {
        const { manager, server, instance, alice, bob } = startGame();
        for (let turnNo = 0; turnNo < 3; turnNo++) {
            server.handleMessage(alice.client, buildRequestFrame(turnNo, noop()));
            server.handleMessage(bob.client, buildRequestFrame(turnNo, noop()));
        }
        expect(countBinary(alice.socket)).toBe(3);

        server.handleClose(bob.client);
        const bobRejoin = join(server, manager, instance, "bob");
        const resyncFrames = bobRejoin.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array);
        expect(resyncFrames.length).toBe(3);
        const turnNos = resyncFrames.map(frame => new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, true));
        expect(turnNos).toEqual([0, 1, 2]);
        // Each frame carries a payload parseable as all-player actions.
        for (const frame of resyncFrames) {
            expect(frame[0]).toBe(2);
            expect(frame[1]).toBe(2);
            expect(parseAllPlayerActions(frame.subarray(6)).size).toBe(2);
        }
    });
});

describe("GservServer in-game chat", () => {
    function chatSetup() {
        const { manager, server } = setup();
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        return { server, instance, alice, bob };
    }

    test("relays #all chat to other members as :nick PRIVMSG #all :text", () => {
        const { server, alice, bob } = chatSetup();
        server.handleMessage(alice.client, "privmsg #all :hello bob");
        const relayed = bob.socket.lines().find((line) => line.includes("PRIVMSG #all :hello bob"));
        expect(relayed).toBe(":alice PRIVMSG #all :hello bob");
        // The sender must not receive a duplicate relay; the client echoes
        // their own message locally.
        expect(alice.socket.lines().filter((line) => line.includes("PRIVMSG #all :hello bob"))).toHaveLength(0);
    });

    test("relays comma-separated recipient lists (team chat) to each member", () => {
        const { server, alice, bob } = chatSetup();
        server.handleMessage(alice.client, "privmsg bob,alice :hi team");
        expect(bob.socket.lines().filter((line) => line.includes("PRIVMSG bob :hi team"))).toHaveLength(1);
        expect(alice.socket.lines().filter((line) => line.includes("PRIVMSG bob :hi team"))).toHaveLength(0);
    });

    test("ignores recipients that are not room members", () => {
        const { server, alice, bob } = chatSetup();
        server.handleMessage(alice.client, "privmsg ghost :hello");
        expect(bob.socket.lines().filter((line) => line.includes("PRIVMSG"))).toHaveLength(0);
        const aliceLines = alice.socket.lines().join("\n");
        expect(aliceLines).toContain(" 805 ");
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
