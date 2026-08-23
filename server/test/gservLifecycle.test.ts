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

        // Game ended: solo player disconnects. The rejoin window opens; since
        // they were the last human, it's immediately extended to the longer
        // abandoned-instance timeout (see "abandoned instance" tests below).
        // Once it expires with nobody left, the instance is retired (endedAt
        // set) so the game-res report can still be validated, and is removed
        // once the report window closes.
        server.handleClose(alice.client);
        const retained = manager.get(instance.gameId);
        expect(retained).toBeDefined();
        expect(retained!.endedAt).toBeUndefined();
        const graceMs = config.abandonedInstanceTimeoutSeconds * 1000;
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

    test("loadinfo reports a departed player's rejoin deadline as the last field", () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_RECONNECT_GRACE_SECONDS: "30" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        // Alice stays connected, so bob's drop uses the plain per-player grace
        // window, not the abandoned-instance extension.
        server.handleClose(bob.client);
        server.handleMessage(alice.client, "loadinfo");
        const lines = alice.socket.sent.filter((data): data is string => typeof data === "string").join("\n");
        const loadInfoLine = lines.split("\n").filter((line) => line.includes(" 600 ")).at(-1)!;
        const match = loadInfoLine.match(/bob,0,0,0,0,(\d+)/);
        expect(match).not.toBeNull();
        const timeoutAt = Number(match![1]);
        expect(timeoutAt).toBeGreaterThan(Date.now());
        expect(timeoutAt).toBeLessThanOrEqual(Date.now() + config.reconnectGraceSeconds * 1000 + 5);
    });

    test("loadinfo reports a still-catching-up rejoiner as status 4 with live replay progress", () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_RECONNECT_GRACE_SECONDS: "30" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const lastLoadInfo = () => alice.socket.sent
            .filter((data): data is string => typeof data === "string")
            .join("\n")
            .split("\n")
            .filter((line) => line.includes(" 600 "))
            .at(-1)!;

        // Dropped but not yet back: status 0 (NotConnected).
        server.handleClose(bob.client);
        server.handleMessage(alice.client, "loadinfo");
        expect(lastLoadInfo()).toMatch(/bob,0,\d+,0,0,\d+/);

        // Reconnected, but still replaying from turn 0 -- status 4 (Rejoining),
        // so waiting players can be shown catch-up progress rather than a
        // reconnect countdown. The percentage rides the ordinary "loaded"
        // message, which is inert mid-game (checkAllLoaded no-ops once started).
        const bobRejoin = join(server, manager, instance, "bob");
        server.handleMessage(bobRejoin.client, "loaded 37");
        server.handleMessage(alice.client, "loadinfo");
        expect(lastLoadInfo()).toContain("bob,4,37,");

        // Caught up and readied: back to status 1 (Connected).
        server.handleMessage(bobRejoin.client, "ready 0");
        server.handleMessage(alice.client, "loadinfo");
        expect(lastLoadInfo()).toContain("bob,1,37,");
    });
});

describe("GservServer mid-game reconnect", () => {
    const noop = () => serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
    const countBinary = (socket: FakeSocket) => socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length;

    function startGame() {
        return startGameWithConfig(setup().config);
    }

    function startGameWithConfig(config: ReturnType<typeof loadConfig>) {
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        return { config, manager, server, instance, alice, bob };
    }

    function fastRejoinConfig() {
        return loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_REJOIN_RESUME_COUNTDOWN_MILLIS: "5" });
    }

    test("mid-game drop opens a rejoin window that holds the relay until rejoin", async () => {
        const { manager, server, instance, alice, bob } = startGameWithConfig(fastRejoinConfig());
        expect(instance.started).toBe(true);

        // Turn 0 relays normally.
        server.handleMessage(alice.client, buildRequestFrame(0, noop()));
        server.handleMessage(bob.client, buildRequestFrame(0, noop()));
        expect(countBinary(alice.socket)).toBe(1);

        // Bob drops: the relay must hold (no backfill), others are notified.
        server.handleClose(bob.client);
        const aliceLines = alice.socket.lines().join("\n");
        expect(aliceLines).toContain(" 804 ");
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

        // Bob signals ready; a short resume countdown runs before the relay
        // resumes once both submit turn 1.
        server.handleMessage(bobRejoin.client, "ready 0");
        server.handleMessage(bobRejoin.client, buildRequestFrame(1, noop()));
        await Bun.sleep(20);
        expect(countBinary(alice.socket)).toBe(2);
        expect(countBinary(bobRejoin.socket)).toBe(2);
        expect(alice.socket.lines().join("\n")).toContain(" 807 ");
    });

    test("the socket closing after a voluntary leave does not reopen a rejoin window", () => {
        // "Abort Mission" sends `leave` and *then* the page tears the socket
        // down, so handleClose always runs a moment after handleLeave for the
        // same nick. handleClose must not treat that trailing close as a fresh
        // mid-game drop: the player already resigned, so re-adding them to
        // requiredNicks would freeze the relay for the whole grace window
        // waiting on someone who is never coming back, then resign them a
        // second time when it expired. isRequiredRosterPlayer() checks the
        // roster rather than requiredNicks, so leftNicks is what has to
        // exclude them.
        const { server, alice, bob } = startGameWithConfig(fastRejoinConfig());
        server.handleMessage(alice.client, buildRequestFrame(0, noop()));
        server.handleMessage(bob.client, buildRequestFrame(0, noop()));
        expect(countBinary(alice.socket)).toBe(1);

        server.handleMessage(bob.client, "leave");
        server.handleClose(bob.client);

        const state = (server as any).instanceStates.get((server as any).clients.get(alice.socket).instance.gameId);
        expect(state.requiredNicks.has("bob")).toBe(false);
        expect(state.departedAt.has("bob")).toBe(false);
        // No rejoin window was announced, so nobody is told to wait for him.
        expect(alice.socket.lines().join("\n")).not.toContain(" 806 ");
        // And the relay keeps flowing on alice's submissions alone.
        server.handleMessage(alice.client, buildRequestFrame(1, noop()));
        expect(countBinary(alice.socket)).toBe(2);
    });

    test("a passive player who then disconnects is still treated as a full required drop", async () => {
        // A backgrounded browser tab going passive (active 0) immediately
        // before its socket actually closes is exactly what happens when a
        // tab is closed: visibilitychange fires (hidden) before the socket
        // does, so GameAnimationLoop's handleVisibilityChange sends "active 0"
        // moments ahead of the real disconnect. Found via manual multiplayer
        // testing that this made handleClose take the observer/passive branch
        // (bob was no longer in requiredNicks at that instant) instead of the
        // required-player branch -- no grace window ever opened, no pause, no
        // RPL_PLAYER_RECONNECTING -- silently ending bob's participation
        // instead of giving him a chance to reconnect. isRequiredRosterPlayer()
        // fixes this: it's checked against the roster (unaffected by passive
        // status), and handleClose now unconditionally re-adds a required
        // player to requiredNicks on drop regardless of whether they were
        // already there.
        const { manager, server, instance, alice, bob } = startGameWithConfig(fastRejoinConfig());
        const noop = () => serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        const countBinary = (socket: FakeSocket) => socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length;

        for (let turnNo = 0; turnNo < 3; turnNo++) {
            server.handleMessage(alice.client, buildRequestFrame(turnNo, noop()));
            server.handleMessage(bob.client, buildRequestFrame(turnNo, noop()));
        }
        expect(countBinary(alice.socket)).toBe(3);

        server.handleMessage(bob.client, "active 0");
        server.handleClose(bob.client);
        const aliceLines = alice.socket.lines().join("\n");
        expect(aliceLines).toContain(" 804 ");
        expect(aliceLines).toContain(" 806 "); // RPL_PLAYER_RECONNECTING -- was never sent before the fix.

        // The relay must hold (no backfill) exactly like any other required
        // drop, not continue as if bob no longer mattered.
        for (let turnNo = 3; turnNo < 6; turnNo++) {
            server.handleMessage(alice.client, buildRequestFrame(turnNo, noop()));
        }
        expect(countBinary(alice.socket)).toBe(3);

        // Bob rejoins: the relay must hold during his catch-up.
        const bobRejoin = join(server, manager, instance, "bob");
        expect(bobRejoin.socket.lines().join("\n")).toContain(" 701 ");
        server.handleMessage(alice.client, buildRequestFrame(3, noop()));
        expect(countBinary(alice.socket)).toBe(3);

        // Bob readies and submits the next turn: after the resume countdown the
        // relay resumes and flushes the whole backlog.
        server.handleMessage(bobRejoin.client, "ready 2");
        server.handleMessage(bobRejoin.client, buildRequestFrame(3, noop()));
        await Bun.sleep(20);
        expect(countBinary(alice.socket)).toBe(4);
        expect(alice.socket.lines().join("\n")).toContain(" 807 ");
    });

    test("desync detection broadcasts RPL_GAME_DESYNC when client hashes differ", () => {
        const { manager, server, instance, alice, bob } = startGame();
        const hashFrame = (turnNo: number, hash: number) => {
            const frame = new Uint8Array(10);
            frame[0] = 2;
            frame[1] = 2;
            new DataView(frame.buffer).setUint32(2, turnNo, true);
            new DataView(frame.buffer).setUint32(6, hash, true);
            return frame;
        };
        server.handleMessage(alice.client, hashFrame(100, 1234));
        server.handleMessage(bob.client, hashFrame(100, 5678));
        expect(alice.socket.lines().join("\n")).toContain(" 801 ");
        expect(bob.socket.lines().join("\n")).toContain(" 801 ");
    });

    test("matching client hashes do not trigger a desync", () => {
        const { manager, server, instance, alice, bob } = startGame();
        const hashFrame = (turnNo: number, hash: number) => {
            const frame = new Uint8Array(10);
            frame[0] = 2;
            frame[1] = 2;
            new DataView(frame.buffer).setUint32(2, turnNo, true);
            new DataView(frame.buffer).setUint32(6, hash, true);
            return frame;
        };
        server.handleMessage(alice.client, hashFrame(100, 1234));
        server.handleMessage(bob.client, hashFrame(100, 1234));
        expect(alice.socket.lines().join("\n")).not.toContain(" 801 ");
    });

    test("mid-game rejoin window expiry backfills the player and play resumes", () => {        const { config, server, alice, bob } = startGame();
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

describe("GservServer whole-game pause", () => {
    const noop = () => serializePlayerActions([{ id: 0, params: new Uint8Array() }]);

    async function startGame(countdownMillis: number) {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_PAUSE_COUNTDOWN_MILLIS: String(countdownMillis) });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        return { config, manager, server, instance, alice, bob };
    }

    test("pause holds the relay after a countdown and resume flushes it", async () => {
        const { server, alice, bob } = await startGame(10);
        server.handleMessage(alice.client, buildRequestFrame(0, noop()));
        server.handleMessage(bob.client, buildRequestFrame(0, noop()));
        const binaryCount = (socket: FakeSocket) => socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length;
        expect(binaryCount(alice.socket)).toBe(1);

        // Pause request: countdown broadcast; once it ends the relay holds.
        server.handleMessage(alice.client, "pause");
        expect(alice.socket.lines().join("\n")).toContain(" 809 ");
        await Bun.sleep(50);
        expect(alice.socket.lines().join("\n")).toContain(" 810 ");
        server.handleMessage(alice.client, buildRequestFrame(1, noop()));
        server.handleMessage(bob.client, buildRequestFrame(1, noop()));
        expect(binaryCount(alice.socket)).toBe(1);

        // Resume request: countdown broadcast, then the backlog flushes.
        server.handleMessage(bob.client, "resume");
        expect(alice.socket.lines().join("\n")).toContain(" 811 ");
        await Bun.sleep(50);
        expect(alice.socket.lines().join("\n")).toContain(" 812 ");
        expect(binaryCount(alice.socket)).toBe(2);
    });

    test("pause requests are rate limited per player", async () => {
        const { server, alice } = await startGame(10);
        server.handleMessage(alice.client, "pause");
        server.handleMessage(alice.client, "pause");
        const countdownLines = alice.socket.lines().filter((line) => line.includes(" 809 "));
        expect(countdownLines.length).toBe(1);
    });

    test("resume during the pause countdown cancels the pause", async () => {
        const { server, alice, bob } = await startGame(10_000);
        server.handleMessage(alice.client, "pause");
        server.handleMessage(bob.client, "resume");
        await Bun.sleep(50);
        expect(alice.socket.lines().join("\n")).not.toContain(" 810 ");
    });

    test("a manual pause freezes a departed player's rejoin deadline and shifts it forward on resume", async () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_PAUSE_COUNTDOWN_MILLIS: "5", GSERV_RECONNECT_GRACE_SECONDS: "30" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob", "carol"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob", "carol"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        const carol = join(server, manager, instance, "carol");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        server.handleMessage(carol.client, "loaded 100");

        // Bob drops: a 30s rejoin window opens, unrelated to the pause below.
        server.handleClose(bob.client);
        const state = (server as any).instanceStates.get(instance.gameId);
        const deadlineAtDrop = state.departedAt.get("bob");

        // Alice and carol pause the game for a while.
        server.handleMessage(alice.client, "pause");
        await Bun.sleep(20);
        expect(alice.socket.lines().join("\n")).toContain(" 810 ");
        await Bun.sleep(100);
        server.handleMessage(carol.client, "resume");
        await Bun.sleep(20);
        expect(alice.socket.lines().join("\n")).toContain(" 812 ");

        // Bob's deadline must be pushed out by roughly the paused duration,
        // not silently eaten by it.
        const deadlineAfterResume = state.departedAt.get("bob");
        expect(deadlineAfterResume).toBeGreaterThan(deadlineAtDrop);
        expect(deadlineAfterResume - deadlineAtDrop).toBeGreaterThan(80);
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

describe("GservServer voluntary leave", () => {
    const noop = () => serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
    const countBinary = (socket: FakeSocket) => socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length;

    function startGame() {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        return { manager, server, instance, alice, bob };
    }

    test("leave resigns immediately with no rejoin grace window", () => {
        const { server, instance, alice, bob } = startGame();
        server.handleMessage(alice.client, buildRequestFrame(0, noop()));
        server.handleMessage(bob.client, buildRequestFrame(0, noop()));
        expect(countBinary(alice.socket)).toBe(1);

        server.handleMessage(bob.client, "leave");
        const aliceLines = alice.socket.lines().join("\n");
        expect(aliceLines).toContain(" 808 "); // RPL_PLAYER_GAVE_UP
        expect(aliceLines).not.toContain(" 806 "); // never treated as "reconnecting"

        const state = (server as any).instanceStates.get(instance.gameId);
        expect(state.departedAt.has("bob")).toBe(false);
        expect(state.requiredNicks.has("bob")).toBe(false);

        // The relay no longer waits on bob for future turns.
        server.handleMessage(alice.client, buildRequestFrame(1, noop()));
        expect(countBinary(alice.socket)).toBe(2);
    });

    test("a player who left cannot rejoin even with a still-valid ticket", () => {
        const { manager, server, instance, bob } = startGame();
        server.handleMessage(bob.client, "leave");

        const bobRejoin = join(server, manager, instance, "bob");
        expect(bobRejoin.client.instance).toBeUndefined();
        expect(bobRejoin.socket.lines().join("\n")).toContain(" 402 "); // RPL_INSTANCE_NOT_ALLOWED
    });
});

describe("GservServer abandoned instance (all humans gone)", () => {
    function startGame(extraEnv: Record<string, string> = {}) {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_RECONNECT_GRACE_SECONDS: "5", GSERV_REJOIN_RESUME_COUNTDOWN_MILLIS: "5", ...extraEnv });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        return { config, manager, server, instance, alice, bob };
    }

    test("last human disconnecting pauses the instance and extends every deadline past the short per-player grace", () => {
        const { config, manager, server, instance, alice, bob } = startGame({ GSERV_ABANDONED_TIMEOUT_SECONDS: "120" });

        server.handleClose(alice.client);
        server.handleClose(bob.client);

        const state = (server as any).instanceStates.get(instance.gameId);
        expect(state.paused).toBe(true);
        for (const nick of ["alice", "bob"]) {
            expect(state.departedAt.get(nick)).toBeGreaterThan(Date.now() + config.reconnectGraceSeconds * 1000);
        }

        // The short per-player grace passing must not resign anyone yet.
        server.runSweepPass(Date.now() + config.reconnectGraceSeconds * 1000 + 1);
        expect(manager.get(instance.gameId)).toBeDefined();
        expect(state.requiredNicks.has("alice")).toBe(true);

        // Once the longer abandoned-instance timeout passes, it resigns
        // everyone and finalizes exactly like a normal expiry.
        server.runSweepPass(Date.now() + 120_000 + 1);
        expect(state.requiredNicks.size).toBe(0);
    });

    test("GSERV_ABANDONED_TIMEOUT_SECONDS=0 holds the instance indefinitely", () => {
        const { config, manager, server, instance, alice, bob } = startGame({ GSERV_ABANDONED_TIMEOUT_SECONDS: "0" });
        server.handleClose(alice.client);
        server.handleClose(bob.client);

        const state = (server as any).instanceStates.get(instance.gameId);
        expect(state.paused).toBe(true);

        // Sweeping far past any realistic per-player or abandoned timeout must
        // never expire either player.
        server.runSweepPass(Date.now() + config.reconnectGraceSeconds * 1000 + 1);
        server.runSweepPass(Date.now() + 365 * 24 * 60 * 60 * 1000);
        expect(state.requiredNicks.size).toBe(2);
        expect(manager.get(instance.gameId)).toBeDefined();
    });

    test("a human reconnecting into an abandoned (auto-paused) instance un-pauses it once everyone is back", async () => {
        const { manager, server, instance, alice, bob } = startGame({ GSERV_ABANDONED_TIMEOUT_SECONDS: "120" });
        server.handleClose(alice.client);
        server.handleClose(bob.client);
        const state = (server as any).instanceStates.get(instance.gameId);
        expect(state.paused).toBe(true);

        // Both players were required and both are still away: only alice
        // being back must not clear the flag, or a resume broadcast would lie
        // to her while the relay keeps holding on bob.
        const aliceRejoin = join(server, manager, instance, "alice");
        server.handleMessage(aliceRejoin.client, "ready 0");
        await Bun.sleep(20);
        expect(state.paused).toBe(true);

        // Once bob is back too, the instance actually un-pauses.
        const bobRejoin = join(server, manager, instance, "bob");
        server.handleMessage(bobRejoin.client, "ready 0");
        await Bun.sleep(20);
        expect(state.paused).toBe(false);
    });
});

describe("GservServer kick/wait voting", () => {
    // Observers get the sentinel country id (OBSERVER_COUNTRY_ID = -3) so
    // isObserverPlayer() picks them out; everyone else keeps a real country.
    function buildGameOptsWithObserver(names: string[], observerName: string): string {
        const optionsPart = "0,0,0,10000,50,0,0,0,1,0,0,0,SXNsYW5kIFdhcg==,8,1,100,mpdefault,abc,1,0,0,1,0";
        const playersPart = names
            .map((name, i) => `${name},${name === observerName ? -3 : 1},${i + 1},${i + 1},1,0,0,0`)
            .join(",");
        return `${optionsPart}:${playersPart}:@:,-1,-1,-1,-1,`;
    }

    function startVoteGame(names: string[], env: Record<string, string> = {}, gameopts?: string) {
        const config = loadConfig({
            GSERV_NET_RATE_MS: "33",
            GSERV_RECONNECT_GRACE_SECONDS: "30",
            // A real drop only becomes vote-eligible after voteOpenDelayMillis
            // (10s in production -- see config.ts's rationale comment): most
            // drops are a brief blip that resolves itself well within that
            // window and should never surface a vote. Shortened here so tests
            // can drive it with a short real sleep instead of waiting 10s.
            GSERV_VOTE_OPEN_DELAY_MILLIS: "5",
            ...env,
        });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(names, "ws://gserv");
        instance.gameopts = gameopts ?? buildGameOpts(names);
        const clients = new Map<string, { socket: FakeSocket; client: GservClient }>();
        for (const nick of names) {
            clients.set(nick, join(server, manager, instance, nick));
        }
        for (const nick of names) {
            server.handleMessage(clients.get(nick)!.client, "loaded 100");
        }
        const state = (server as any).instanceStates.get(instance.gameId);
        return { config, manager, server, instance, clients, state };
    }

    // Drops `nick` and waits past voteOpenDelayMillis, so any vote session the
    // drop is eligible for has actually opened by the time this returns --
    // mirroring how a real client only sees the vote appear a while after the
    // drop, not instantly. Most tests below care about the vote itself, not
    // this delay mechanism (which has its own dedicated test), so they all
    // route through here rather than each re-deriving the wait.
    async function dropAndWaitForVote(server: GservServer, clients: Map<string, { socket: FakeSocket; client: GservClient }>, nick: string): Promise<void> {
        server.handleClose(clients.get(nick)!.client);
        await Bun.sleep(20);
    }

    const linesOf = (socket: FakeSocket) => socket.sent
        .filter((data): data is string => typeof data === "string")
        .join("")
        .split("\r\n")
        .filter(Boolean);

    const lastVoteUpdate = (socket: FakeSocket) => linesOf(socket).filter((line) => line.includes(" 814 ")).at(-1);
    // ":<target>,<kick>,<wait>,<extLeft>,<eligible>,<threshold>,<ballot>"
    const tallyOf = (socket: FakeSocket) => {
        const line = lastVoteUpdate(socket);
        if (!line) return undefined;
        const payload = line.slice(line.indexOf(" :") + 2).split(",");
        return {
            target: payload[0],
            kick: Number(payload[1]),
            wait: Number(payload[2]),
            extensionsRemaining: Number(payload[3]),
            eligible: Number(payload[4]),
            threshold: Number(payload[5]),
        };
    };

    test("a vote does not open until the departed player is still away after the open delay", async () => {
        const { manager, server, instance, clients, state } = startVoteGame(["alice", "bob", "carol"]);
        server.handleClose(clients.get("carol")!.client);
        // Immediately after the drop: nothing has opened yet. This is the
        // entire point of the delay -- a brief blip must not force a vote.
        expect(state.voteSessions.has("carol")).toBe(false);
        expect(state.pendingVoteOpens.has("carol")).toBe(true);

        // She reconnects well within the delay: the pending open is cancelled
        // outright and never fires, so this drop never offers a vote at all.
        join(server, manager, instance, "carol");
        expect(state.pendingVoteOpens.has("carol")).toBe(false);
        await Bun.sleep(20);
        expect(state.voteSessions.has("carol")).toBe(false);
    });

    test("a 2-player game never opens a vote session", async () => {
        const { server, clients, state } = startVoteGame(["alice", "bob"]);
        await dropAndWaitForVote(server, clients, "bob");

        expect(state.voteSessions.size).toBe(0);
        // A vote command against a nick with no session is silently ignored.
        server.handleMessage(clients.get("alice")!.client, "vote bob kick");
        expect(state.voteSessions.size).toBe(0);
        expect(linesOf(clients.get("alice")!.socket).some((line) => line.includes(" 813 ") || line.includes(" 814 "))).toBe(false);
        expect(state.requiredNicks.has("bob")).toBe(true);
    });

    test("a kick majority with no wait votes resigns the departed player early", async () => {
        const { server, clients, state } = startVoteGame(["alice", "bob", "carol", "dave"]);
        await dropAndWaitForVote(server, clients, "dave");
        expect(state.voteSessions.has("dave")).toBe(true);

        // 3 eligible voters (alice, bob, carol) -> majority is 2.
        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 1, wait: 0, eligible: 3, threshold: 2 });
        expect(state.requiredNicks.has("dave")).toBe(true);

        server.handleMessage(clients.get("bob")!.client, "vote dave kick");
        // Resolved: resigned early, well inside the 30s grace window.
        expect(state.voteSessions.has("dave")).toBe(false);
        expect(state.requiredNicks.has("dave")).toBe(false);
        expect(state.leftNicks.has("dave")).toBe(true);
        expect(state.departedAt.has("dave")).toBe(false);
        const aliceLines = linesOf(clients.get("alice")!.socket);
        expect(aliceLines.some((line) => line.includes(" 815 ") && line.includes("dave"))).toBe(true);
        expect(aliceLines.some((line) => line.includes(" 808 ") && line.includes("dave"))).toBe(true);
    });

    test("a single wait vote spends one extension and vetoes an otherwise-passing kick", async () => {
        const { config, server, clients, state } = startVoteGame(["alice", "bob", "carol", "dave"]);
        await dropAndWaitForVote(server, clients, "dave");
        const deadlineBefore = state.departedAt.get("dave");

        server.handleMessage(clients.get("carol")!.client, "vote dave wait");
        expect(state.departedAt.get("dave")).toBe(deadlineBefore + config.voteExtensionSeconds * 1000);
        expect(state.voteSessions.get("dave").extensionsRemaining).toBe(config.voteExtensionsMax - 1);

        // A standing wait vote with extensions left blocks the kick even once
        // the majority threshold is met.
        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        server.handleMessage(clients.get("bob")!.client, "vote dave kick");
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 2, wait: 1, threshold: 2 });
        expect(state.voteSessions.has("dave")).toBe(true);
        expect(state.requiredNicks.has("dave")).toBe(true);
    });

    test("each wait voter buys one extension, and only one", async () => {
        const { config, server, clients, state } = startVoteGame(["alice", "bob", "carol", "dave"], {
            GSERV_VOTE_EXTENSIONS_MAX: "2",
        });
        await dropAndWaitForVote(server, clients, "dave");
        const deadlineBefore = state.departedAt.get("dave");

        server.handleMessage(clients.get("carol")!.client, "vote dave wait");
        expect(state.voteSessions.get("dave").extensionsRemaining).toBe(1);
        expect(state.departedAt.get("dave")).toBe(deadlineBefore + config.voteExtensionSeconds * 1000);

        // The same voter cannot buy a second one, however many times the tally
        // is recomputed -- another player's vote forces a recount here.
        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        expect(state.voteSessions.get("dave").extensionsRemaining).toBe(1);
        expect(state.departedAt.get("dave")).toBe(deadlineBefore + config.voteExtensionSeconds * 1000);

        // A *different* wait voter buys the second one, draining the pool.
        // Total purchasable time is therefore capped at
        // extensionsMax * extensionSeconds regardless of roster size.
        server.handleMessage(clients.get("bob")!.client, "vote dave wait");
        expect(state.voteSessions.get("dave").extensionsRemaining).toBe(0);
        expect(state.departedAt.get("dave")).toBe(deadlineBefore + 2 * config.voteExtensionSeconds * 1000);
    });

    test("a cast vote is final: a second vote from the same player is ignored", async () => {
        const { config, server, clients, state } = startVoteGame(["alice", "bob", "carol", "dave"], {
            GSERV_VOTE_EXTENSIONS_MAX: "2",
        });
        await dropAndWaitForVote(server, clients, "dave");
        const deadlineBefore = state.departedAt.get("dave");

        server.handleMessage(clients.get("carol")!.client, "vote dave wait");
        expect(state.voteSessions.get("dave").votes.get("carol")).toBe("wait");
        expect(state.voteSessions.get("dave").extensionsRemaining).toBe(1);

        // Flipping to kick and back is exactly how a modified client would try
        // to re-earn wait extensions. The server refuses the second vote
        // outright, so the choice stands and the pool is untouched.
        server.handleMessage(clients.get("carol")!.client, "vote dave kick");
        expect(state.voteSessions.get("dave").votes.get("carol")).toBe("wait");
        server.handleMessage(clients.get("carol")!.client, "vote dave wait");
        expect(state.voteSessions.get("dave").extensionsRemaining).toBe(1);
        expect(state.departedAt.get("dave")).toBe(deadlineBefore + config.voteExtensionSeconds * 1000);
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 0, wait: 1 });
    });

    test("once the extension pool is spent, wait votes are advisory and a kick majority carries", async () => {
        const { server, clients, state } = startVoteGame(["alice", "bob", "carol", "dave"], {
            GSERV_VOTE_EXTENSIONS_MAX: "1",
        });
        await dropAndWaitForVote(server, clients, "dave");

        // Drain the single extension.
        server.handleMessage(clients.get("carol")!.client, "vote dave wait");
        expect(state.voteSessions.get("dave").extensionsRemaining).toBe(0);

        // carol keeps voting wait, but the veto is spent -- the majority wins.
        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        server.handleMessage(clients.get("bob")!.client, "vote dave kick");
        expect(state.voteSessions.has("dave")).toBe(false);
        expect(state.requiredNicks.has("dave")).toBe(false);
        expect(state.leftNicks.has("dave")).toBe(true);
    });

    test("the departed player reconnecting cancels the vote immediately", async () => {
        const { manager, server, instance, clients, state } = startVoteGame(["alice", "bob", "carol", "dave"]);
        await dropAndWaitForVote(server, clients, "dave");
        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        expect(state.voteSessions.has("dave")).toBe(true);

        // Closed on rejoin, not on ready: otherwise the vote UI would stay open
        // for the whole turn-0 replay.
        const daveRejoin = join(server, manager, instance, "dave");
        expect(state.voteSessions.has("dave")).toBe(false);
        expect(linesOf(clients.get("alice")!.socket).some((line) => line.includes(" 815 ") && line.includes("dave"))).toBe(true);
        expect(state.requiredNicks.has("dave")).toBe(true);
        expect(state.leftNicks.has("dave")).toBe(false);

        // The ordinary rejoin flow is unaffected.
        server.handleMessage(daveRejoin.client, "ready 0");
        expect(state.rejoiningNicks.has("dave")).toBe(false);
    });

    test("each player's vote counts exactly once", async () => {
        const { server, clients } = startVoteGame(["alice", "bob", "carol", "dave"]);
        await dropAndWaitForVote(server, clients, "dave");

        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 1, wait: 0, eligible: 3 });

        // Re-sending the same choice must not double-count it either.
        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 1, wait: 0 });

        server.handleMessage(clients.get("bob")!.client, "vote dave wait");
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 1, wait: 1 });
    });

    test("observers cannot vote", async () => {
        const names = ["alice", "bob", "carol", "dave"];
        const { server, clients, state } = startVoteGame(
            names,
            {},
            buildGameOptsWithObserver(names, "carol"),
        );
        await dropAndWaitForVote(server, clients, "dave");

        // carol is an observer, so she is neither required by the relay nor an
        // eligible voter: 2 eligible (alice, bob), majority 2.
        server.handleMessage(clients.get("carol")!.client, "vote dave kick");
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 0, eligible: 2, threshold: 2 });
        expect(state.voteSessions.has("dave")).toBe(true);
    });

    test("a second departure shrinks the electorate and re-tallies the open vote", async () => {
        const { server, clients, state } = startVoteGame(["alice", "bob", "carol", "dave"]);
        await dropAndWaitForVote(server, clients, "dave");

        // 3 eligible -> majority 2; a lone kick vote is not enough.
        server.handleMessage(clients.get("alice")!.client, "vote dave kick");
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 1, eligible: 3, threshold: 2 });
        expect(state.voteSessions.has("dave")).toBe(true);

        // carol drops: 2 eligible (alice, bob) -> majority is still 2, and only
        // alice has voted, so dave's vote stays open rather than resolving off
        // a shrinking electorate. This re-tally is synchronous (handleClose
        // resolves every *other* open session immediately, independent of the
        // new open-delay, which only gates *opening a fresh* session), so no
        // extra wait is needed here.
        server.handleClose(clients.get("carol")!.client);
        expect(tallyOf(clients.get("alice")!.socket)).toMatchObject({ kick: 1, eligible: 2, threshold: 2 });
        expect(state.voteSessions.has("dave")).toBe(true);

        // bob agreeing now carries it.
        server.handleMessage(clients.get("bob")!.client, "vote dave kick");
        expect(state.voteSessions.has("dave")).toBe(false);
        expect(state.requiredNicks.has("dave")).toBe(false);
    });

    test("a second concurrent departure closes an open vote rather than letting one voter carry it alone", async () => {
        // Exactly at the 3-player minimum: carol dropping opens a vote on her
        // (requiredNicks.size === 3 satisfies voteMinRequiredPlayers). Before
        // anyone votes, bob *also* drops -- isVotingEligible() was only ever
        // checked once, at session-open time, against requiredNicks.size,
        // which does not shrink just because someone is merely departed
        // (only resigning does). Left unguarded, alice would become the sole
        // eligible voter on carol's session (majorityThreshold 1) and could
        // single-handedly kick her -- exactly the "lone remaining player
        // decides another's fate" outcome voteMinRequiredPlayers exists to
        // prevent, just reached via a second disconnect instead of a
        // resignation.
        const { server, clients, state } = startVoteGame(["alice", "bob", "carol"]);
        await dropAndWaitForVote(server, clients, "carol");
        expect(state.voteSessions.has("carol")).toBe(true);

        // bob's own drop only schedules *his own* pending vote open (subject to
        // the same delay); the re-tally of carol's *already-open* session is
        // synchronous, so no extra wait is needed to observe it closing.
        server.handleClose(clients.get("bob")!.client);
        // The re-tally triggered by bob's own drop must close carol's vote
        // outright (not just refuse to resolve it): with only alice left
        // eligible, eligible.length + 1 (accounting for carol herself) is 2,
        // below the minimum of 3.
        expect(state.voteSessions.has("carol")).toBe(false);
        expect(
            linesOf(clients.get("alice")!.socket).some((line) => line.includes(" 815 ") && line.includes("carol")),
        ).toBe(true);

        // Confirms the exploit is actually closed, not just untested: alice
        // voting kick now has no session to land on at all.
        server.handleMessage(clients.get("alice")!.client, "vote carol kick");
        expect(state.requiredNicks.has("carol")).toBe(true);
        expect(state.leftNicks.has("carol")).toBe(false);

        // The grace timer (untouched by voting closing) still governs carol's
        // fate normally, exactly as in a 2-player game.
        expect(state.departedAt.has("carol")).toBe(true);
    });
});
