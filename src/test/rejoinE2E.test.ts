import { describe, expect, test } from "bun:test";
import { IrcConnection } from "@/network/IrcConnection";
import { GservConnection } from "@/network/GservConnection";
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
    test("dropped player rejoins with the same ticket, receives the resync log, and play resumes", () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);

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
            server.handleMessage(client, `join ${instance.gameId} 0.83 `);
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

        // The rejoining client signals ready; the relay resumes once both
        // players submit turn 1.
        bobRejoin.gserv.sendReady(0);
        alice.pump();
        expect(alice.reconnected).toEqual(["bob"]);
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
            server.handleMessage(client, `join ${instance.gameId} 0.83 `);
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
});
