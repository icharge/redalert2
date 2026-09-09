import { describe, expect, test } from "bun:test";
import { IrcConnection } from "@/network/IrcConnection";
import { GservConnection } from "@/network/GservConnection";
import { LockstepManager } from "@/network/gamestate/LockstepManager";
import { Parser } from "@/network/gameopt/Parser";
import { GservServer } from "../../server/src/gserv/GservServer";
import { GservManager } from "../../server/src/gserv/GservManager";
import { loadConfig } from "../../server/src/config";
import { FakeSocket } from "../../server/test/helpers";
import { serializePlayerActions } from "../../server/src/gserv/replay/gameoptCodec";

class FakeIrc extends IrcConnection {
    sent: Array<string | Uint8Array> = [];
    constructor() {
        super({ mode: "text" } as any, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any);
        (this as any).socket = { readyState: 1, send: (data: string | Uint8Array) => this.sent.push(data) };
    }
    dispatch(message: string | Uint8Array): void {
        (this as any)._onMessage.dispatch(this, message);
    }
}

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

describe("E2E: mid-game reconnect and resync over the real gserv stack", () => {
    const makePump = (irc: FakeIrc, socket: FakeSocket) => {
        let cursor = 0;
        return () => {
            for (; cursor < socket.sent.length; cursor++) {
                const data = socket.sent[cursor];
                if (typeof data === "string") {
                    for (const line of data.split("\r\n")) {
                        if (line) {
                            irc.dispatch(line);
                        }
                    }
                }
                else {
                    // The client IrcConnection strips the binary reply prefix.
                    irc.dispatch(data.subarray(1));
                }
            }
        };
    };

    test("dropped player rejoins with the same ticket, receives the resync log, and play resumes", async () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_REJOIN_RESUME_COUNTDOWN_MILLIS: "5" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);

        const joinAs = (nick: string) => {
            const socket = new FakeSocket();
            const client = server.handleOpen(socket);
            const irc = new FakeIrc();
            // Forward the client's outbound messages to the server.
            const ircSocket = (irc as any).socket;
            const originalSend = ircSocket.send.bind(ircSocket);
            ircSocket.send = (data: string | Uint8Array) => {
                originalSend(data);
                server.handleMessage(client, data);
            };
            const gserv = new GservConnection(irc, {} as any);
            (gserv as any).con.onMessage.subscribe((gserv as any).handleMessage);
            const received: Uint8Array[] = [];
            gserv.onGameActions.subscribe((actions: Uint8Array) => received.push(actions));
            const reconnecting: string[] = [];
            const reconnected: string[] = [];
            const gaveUp: string[] = [];
            gserv.onPlayerReconnecting.subscribe((nick: string) => reconnecting.push(nick));
            gserv.onPlayerReconnected.subscribe((nick: string) => reconnected.push(nick));
            gserv.onPlayerGaveUp.subscribe((nick: string) => gaveUp.push(nick));
            server.handleMessage(client, `ticket ${instance.tickets.get(nick)}`);
            server.handleMessage(client, `join ${instance.gameId}`);
            const pump = makePump(irc, socket);
            pump();
            return { socket, client, irc, gserv, pump, received, reconnecting, reconnected, gaveUp };
        };

        const alice = joinAs("alice");
        const bob = joinAs("bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        expect(instance.started).toBe(true);

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        const relayedTurnNos = (entry: { received: Uint8Array[] }) =>
            entry.received.map((payload) => new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true));

        // Turn 0 relays to both players.
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        server.handleMessage(bob.client, buildRequestFrame(0, noop));
        alice.pump();
        bob.pump();
        expect(relayedTurnNos(alice)).toEqual([0]);

        // Bob drops mid-game: the relay holds and alice is notified.
        server.handleClose(bob.client);
        alice.pump();
        expect(alice.reconnecting).toEqual(["bob"]);
        server.handleMessage(alice.client, buildRequestFrame(1, noop));
        alice.pump();
        expect(relayedTurnNos(alice).length).toBe(1);

        // Bob rejoins with the same ticket: connected + net rate + resync log.
        const bobRejoin = joinAs("bob");
        const rejoinLog = bobRejoin.gserv.getResyncLog();
        expect(rejoinLog?.turnCount).toBe(0);
        expect(rejoinLog?.frames.size).toBe(1);
        expect(bobRejoin.gserv.getLastNetRate()).toEqual({ rate: 33, turnNo: 0 });

        // The rejoining client signals ready; a short resume countdown runs
        // before the relay resumes once both players submit turn 1.
        bobRejoin.gserv.sendReady(0);
        alice.pump();
        expect(alice.reconnected).toEqual(["bob"]);
        await Bun.sleep(20);
        server.handleMessage(bobRejoin.client, buildRequestFrame(1, noop));
        alice.pump();
        bobRejoin.pump();
        expect(relayedTurnNos(alice)).toEqual([0, 1]);
        // Bob's turn 0 came through the resync log; turn 1 arrives live.
        expect(relayedTurnNos(bobRejoin)).toEqual([1]);
    });

    test("rejoin grace expiry backfills the departed player and play resumes", () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const joinAs = (nick: string) => {
            const socket = new FakeSocket();
            const client = server.handleOpen(socket);
            server.handleMessage(client, `ticket ${instance.tickets.get(nick)}`);
            server.handleMessage(client, `join ${instance.gameId}`);
            return { socket, client };
        };
        const alice = joinAs("alice");
        const bob = joinAs("bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        server.handleMessage(bob.client, buildRequestFrame(0, noop));
        expect(alice.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length).toBe(1);

        server.handleClose(bob.client);
        server.handleMessage(alice.client, buildRequestFrame(1, noop));
        expect(alice.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length).toBe(1);

        server.runSweepPass(Date.now() + config.reconnectGraceSeconds * 1000 + 1);
        expect(alice.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).length).toBe(2);
        expect(alice.socket.lines().join("\n")).toContain(" 808 ");
    });

    test("resync log frames parse through feedActionsPayload like live relay frames", () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const joinRaw = (nick: string) => {
            const socket = new FakeSocket();
            const client = server.handleOpen(socket);
            server.handleMessage(client, `ticket ${instance.tickets.get(nick)}`);
            server.handleMessage(client, `join ${instance.gameId}`);
            return { socket, client };
        };
        const alice = joinRaw("alice");
        const bob = joinRaw("bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        for (let turnNo = 0; turnNo < 3; turnNo++) {
            server.handleMessage(alice.client, buildRequestFrame(turnNo, noop));
            server.handleMessage(bob.client, buildRequestFrame(turnNo, noop));
        }

        server.handleClose(bob.client);
        const bobRejoin = joinRaw("bob");
        const irc = new FakeIrc();
        const gserv = new GservConnection(irc, {} as any);
        (gserv as any).con.onMessage.subscribe((gserv as any).handleMessage);
        for (const data of bobRejoin.socket.sent) {
            if (typeof data === "string") {
                for (const line of data.split("\r\n")) {
                    if (line) {
                        irc.dispatch(line);
                    }
                }
            }
            else {
                irc.dispatch(data.subarray(1));
            }
        }
        const rejoinLog = gserv.getResyncLog();
        expect(rejoinLog?.turnCount).toBe(2);
        expect(rejoinLog?.frames.size).toBe(3);

        // Feeding the resync frames through the real lockstep parser must not
        // throw (regression: frames were stored without the turn-no prefix).
        const lockstep = new LockstepManager(
            { desiredSpeed: { value: 6 } } as any,
            {} as any,
            new Parser(),
            {} as any,
            {} as any,
            {} as any,
            { dequeueAll: () => [] },
            () => {},
        );
        for (const [turnNo, payload] of [...rejoinLog.frames.entries()].sort((a, b) => a[0] - b[0])) {
            expect(() => lockstep.feedActionsPayload(payload)).not.toThrow();
        }
    });

    test("full rejoin catch-up terminates and live play resumes", async () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_REJOIN_RESUME_COUNTDOWN_MILLIS: "5" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const joinRaw = (nick: string) => {
            const socket = new FakeSocket();
            const client = server.handleOpen(socket);
            server.handleMessage(client, `ticket ${instance.tickets.get(nick)}`);
            server.handleMessage(client, `join ${instance.gameId}`);
            return { socket, client };
        };
        const alice = joinRaw("alice");
        const bob = joinRaw("bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        const turnsPlayed = 6;
        for (let turnNo = 0; turnNo < turnsPlayed; turnNo++) {
            server.handleMessage(alice.client, buildRequestFrame(turnNo, noop));
            server.handleMessage(bob.client, buildRequestFrame(turnNo, noop));
        }

        server.handleClose(bob.client);
        const bobRejoin = joinRaw("bob");
        const irc = new FakeIrc();
        const gserv = new GservConnection(irc, {} as any);
        (gserv as any).con.onMessage.subscribe((gserv as any).handleMessage);
        const sent: Array<string | Uint8Array> = [];
        const ircSocket = (irc as any).socket;
        const originalSend = ircSocket.send.bind(ircSocket);
        ircSocket.send = (data: string | Uint8Array) => {
            originalSend(data);
            sent.push(data);
            server.handleMessage(bobRejoin.client, data);
        };
        for (const data of bobRejoin.socket.sent) {
            if (typeof data === "string") {
                for (const line of data.split("\r\n")) {
                    if (line) {
                        irc.dispatch(line);
                    }
                }
            }
            else {
                irc.dispatch(data.subarray(1));
            }
        }
        const rejoinLog = gserv.getResyncLog();
        expect(rejoinLog?.turnCount).toBe(turnsPlayed - 1);

        // A minimal deterministic game the lockstep can drive.
        let tick = 0;
        const game = {
            status: 1,
            currentTick: 0,
            desiredSpeed: { value: 6 },
            update: () => { tick += 1; game.currentTick = tick; },
            getHash: () => tick,
            getPlayer: () => undefined,
        };
        const lockstep = new LockstepManager(
            game as any,
            gserv as any,
            new Parser(),
            { serializePlayerActions: () => new Uint8Array([0]) } as any,
            { getActionPayload: (a: any) => ({ id: a?.id ?? 0, params: new Uint8Array() }) } as any,
            { create: (id: number) => ({ id, player: undefined, unserialize: () => {}, process: () => {}, print: () => "" }) } as any,
            { dequeueAll: () => [] },
            () => {},
        );
        lockstep.setRate({ rate: 33, turnNo: 0 });
        lockstep.init();

        // Mirror runRejoinCatchUp's pump: feed 0..N-2, advance, preload N-1/N.
        const lastTurnNo = rejoinLog.turnCount;
        for (let turnNo = 0; turnNo <= lastTurnNo - 2; turnNo++) {
            lockstep.feedActionsPayload(rejoinLog.frames.get(turnNo)!);
        }
        const targetTurn = lastTurnNo + 1;
        let guard = 0;
        while (lockstep.getCurrentNetworkTurn() < targetTurn && guard++ < 100_000) {
            lockstep.doGameTurn(performance.now());
        }
        expect(guard).toBeLessThan(100_000);
        expect(lockstep.getCurrentNetworkTurn()).toBe(targetTurn);
        if (lastTurnNo >= 1) {
            lockstep.feedActionsPayload(rejoinLog.frames.get(lastTurnNo - 1)!);
        }
        lockstep.feedActionsPayload(rejoinLog.frames.get(lastTurnNo)!);
        gserv.sendReady(lastTurnNo);
        await Bun.sleep(20);

        // After ready the relay resumes: alice + bob submit the next turn.
        const nextTurn = lastTurnNo + 1;
        server.handleMessage(alice.client, buildRequestFrame(nextTurn, noop));
        server.handleMessage(bobRejoin.client, buildRequestFrame(nextTurn, noop));
        const aliceBin = alice.socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array);
        expect(aliceBin.length).toBe(turnsPlayed + 1);
    });

    test("whole-game pause round trip: countdown, hold, resume", async () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_PAUSE_COUNTDOWN_MILLIS: "10" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const joinAs = (nick: string) => {
            const socket = new FakeSocket();
            const client = server.handleOpen(socket);
            const irc = new FakeIrc();
            const ircSocket = (irc as any).socket;
            const originalSend = ircSocket.send.bind(ircSocket);
            ircSocket.send = (data: string | Uint8Array) => {
                originalSend(data);
                server.handleMessage(client, data);
            };
            const gserv = new GservConnection(irc, {} as any);
            (gserv as any).con.onMessage.subscribe((gserv as any).handleMessage);
            const events: string[] = [];
            gserv.onPauseCountdown.subscribe(() => events.push("pause-countdown"));
            gserv.onPaused.subscribe(() => events.push("paused"));
            gserv.onResumeCountdown.subscribe(() => events.push("resume-countdown"));
            gserv.onResumed.subscribe(() => events.push("resumed"));
            server.handleMessage(client, `ticket ${instance.tickets.get(nick)}`);
            server.handleMessage(client, `join ${instance.gameId}`);
            const pump = makePump(irc, socket);
            pump();
            return { socket, client, irc, gserv, pump, events };
        };
        const alice = joinAs("alice");
        const bob = joinAs("bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        const noop = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        server.handleMessage(alice.client, buildRequestFrame(0, noop));
        server.handleMessage(bob.client, buildRequestFrame(0, noop));
        alice.pump();
        bob.pump();
        expect(alice.events).toEqual([]);

        alice.gserv.sendPause();
        alice.pump();
        bob.pump();
        expect(alice.events).toEqual(["pause-countdown"]);
        expect(bob.events).toEqual(["pause-countdown"]);

        await Bun.sleep(50);
        alice.pump();
        bob.pump();
        expect(alice.events).toEqual(["pause-countdown", "paused"]);

        // While paused, submitted turns are not relayed.
        server.handleMessage(alice.client, buildRequestFrame(1, noop));
        server.handleMessage(bob.client, buildRequestFrame(1, noop));
        alice.pump();
        bob.pump();

        bob.gserv.sendResume();
        bob.pump();
        alice.pump();
        expect(bob.events).toEqual(["pause-countdown", "paused", "resume-countdown"]);

        await Bun.sleep(50);
        alice.pump();
        bob.pump();
        expect(bob.events).toEqual(["pause-countdown", "paused", "resume-countdown", "resumed"]);
        expect(alice.events).toEqual(["pause-countdown", "paused", "resume-countdown", "resumed"]);
    });
});
