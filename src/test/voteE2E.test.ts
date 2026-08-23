import { describe, expect, test } from "bun:test";
import { IrcConnection } from "@/network/IrcConnection";
import { GservConnection, VoteTally } from "@/network/GservConnection";
import { GservServer } from "../../server/src/gserv/GservServer";
import { GservManager } from "../../server/src/gserv/GservManager";
import { loadConfig } from "../../server/src/config";
import { FakeSocket } from "../../server/test/helpers";

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

describe("E2E: kick/wait voting over the real gserv stack", () => {
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

    test("a kick majority closes the vote and resigns the departed player, observed end to end", async () => {
        const config = loadConfig({ GSERV_NET_RATE_MS: "33", GSERV_VOTE_EXTENSIONS_MAX: "1", GSERV_VOTE_OPEN_DELAY_MILLIS: "5" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob", "carol"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob", "carol"]);

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
            const sessionsOpened: string[] = [];
            const sessionsClosed: string[] = [];
            const tallies: VoteTally[] = [];
            const gaveUp: string[] = [];
            gserv.onVoteSessionOpened.subscribe((info) => sessionsOpened.push(info.targetNick));
            gserv.onVoteSessionClosed.subscribe((nick: string) => sessionsClosed.push(nick));
            gserv.onVoteUpdate.subscribe((tally: VoteTally) => tallies.push(tally));
            gserv.onPlayerGaveUp.subscribe((nick: string) => gaveUp.push(nick));
            server.handleMessage(client, `ticket ${instance.tickets.get(nick)}`);
            server.handleMessage(client, `join ${instance.gameId} 0.83 `);
            const pump = makePump(irc, socket);
            pump();
            return { socket, client, irc, gserv, pump, sessionsOpened, sessionsClosed, tallies, gaveUp };
        };

        const alice = joinAs("alice");
        const bob = joinAs("bob");
        const carol = joinAs("carol");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");
        server.handleMessage(carol.client, "loaded 100");
        expect(instance.started).toBe(true);

        // Carol drops: a vote session opens automatically (3 required players
        // clears the GSERV_VOTE_MIN_REQUIRED_PLAYERS default of 3), but only
        // once she's still away after voteOpenDelayMillis -- a brief blip
        // must not force a vote open the instant the socket closes.
        server.handleClose(carol.client);
        await Bun.sleep(20);
        alice.pump();
        expect(alice.sessionsOpened).toEqual(["carol"]);
        expect(alice.tallies.at(-1)).toMatchObject({
            targetNick: "carol",
            kickVotes: 0,
            waitVotes: 0,
            eligibleCount: 2,
            majorityThreshold: 2,
        });

        // Alice votes kick; the text command round-trips through the real
        // protocol parser on both ends.
        alice.gserv.sendVote("carol", "kick");
        alice.pump();
        expect(alice.tallies.at(-1)).toMatchObject({ kickVotes: 1, waitVotes: 0 });
        expect(alice.tallies.at(-1)?.votesByNick.get("alice")).toBe("kick");

        // Bob's kick vote reaches the majority threshold (2 of 2 eligible) and
        // the vote resolves: both sides observe the session closing and the
        // resign broadcast, exactly as a natural grace-window timeout would.
        bob.gserv.sendVote("carol", "kick");
        bob.pump();
        alice.pump();
        expect(bob.sessionsClosed).toEqual(["carol"]);
        expect(bob.gaveUp).toEqual(["carol"]);
        expect(alice.sessionsClosed).toEqual(["carol"]);
        expect(alice.gaveUp).toEqual(["carol"]);

        const state = (server as any).instanceStates.get(instance.gameId);
        expect(state.requiredNicks.has("carol")).toBe(false);
        expect(state.leftNicks.has("carol")).toBe(true);
    });
});
