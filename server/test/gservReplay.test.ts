import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { GservServer, GservClient } from "../src/gserv/GservServer";
import { GservManager, GservInstance } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { FakeSocket } from "./helpers";
import {
    ActionData,
    computeGameTurnMillis,
    computeNetworkTurnMillis,
    parseAllPlayerActions,
    parseGameOpts,
    parsePlayerActions,
    serializeAllPlayerActions,
    serializePlayerActions,
} from "../src/gserv/replay/gameoptCodec";

const OBSERVER_COUNTRY_ID = -3;

// Mirrors Serializer.serializeOptions for 2 human players at gameSpeed 6.
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

function binarySent(socket: FakeSocket): Uint8Array[] {
    return socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array);
}

function setup(replaysDir: string) {
    const config = loadConfig({ REPLAYS_DIR: replaysDir, GSERV_NET_RATE_MS: "33", RECORD_REPLAYS: "true" });
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

describe("gameoptCodec", () => {
    test("serialize/parse player actions round-trips", () => {
        const actions: ActionData[] = [
            { id: 0, params: new Uint8Array() },
            { id: 7, params: new Uint8Array([1, 2, 3, 250]) },
        ];
        expect(parsePlayerActions(serializePlayerActions(actions))).toEqual(actions);
    });

    test("serialize/parse all-player actions round-trips", () => {
        const map = new Map<number, ActionData[]>([
            [0, [{ id: 0, params: new Uint8Array() }]],
            [3, [{ id: 5, params: new Uint8Array([9, 8]) }]],
        ]);
        const roundTrip = parseAllPlayerActions(serializeAllPlayerActions(map));
        expect([...roundTrip]).toEqual([...map]);
    });

    test("parseGameOpts reads gameSpeed and preserves player order", () => {
        const opts = parseGameOpts(buildGameOpts(["alice", "bob"]));
        expect(opts.gameSpeed).toBe(6);
        expect(opts.humanPlayers.map(p => p.name)).toEqual(["alice", "bob"]);
    });
});

describe("GservServer action relay", () => {
    test("buffers each player's actions and broadcasts a combined frame with turnNo", () => {
        const replaysDir = __dirname + "/tmp-replays";
        const { config, manager, server } = setup(replaysDir);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");

        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        expect(alice.socket.lines().some(line => line.startsWith(":gserv-ra2web 802 alice :33,0"))).toBe(true);
        expect(bob.socket.lines().some(line => line.startsWith(":gserv-ra2web 802 bob :33,0"))).toBe(true);
        expect(alice.socket.lines().some(line => line.startsWith(":gserv-ra2web 700 alice :start"))).toBe(true);

        // Turn 0: alice submits a real action, bob submits NoAction.
        const aliceActions = serializePlayerActions([{ id: 5, params: new Uint8Array([1, 2, 3]) }]);
        const bobActions = serializePlayerActions([{ id: 0, params: new Uint8Array() }]);
        server.handleMessage(alice.client, buildRequestFrame(0, aliceActions));
        // Only alice has submitted so far: nothing should be broadcast yet.
        expect(binarySent(alice.socket).length).toBe(0);
        expect(binarySent(bob.socket).length).toBe(0);
        server.handleMessage(bob.client, buildRequestFrame(0, bobActions));

        // Both members must receive exactly one combined frame for turn 0.
        expect(binarySent(alice.socket).length).toBe(1);
        expect(binarySent(bob.socket).length).toBe(1);
        for (const frame of [...binarySent(alice.socket), ...binarySent(bob.socket)]) {
            expect(frame[0]).toBe(2);
            expect(frame[1]).toBe(1);
            expect(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, true)).toBe(0);
            const parsed = parseAllPlayerActions(frame.subarray(6));
            expect(parsed.get(0)).toEqual([{ id: 5, params: new Uint8Array([1, 2, 3]) }]);
            expect(parsed.get(1)).toEqual([{ id: 0, params: new Uint8Array() }]);
        }

        // A turn made up entirely of NoAction is still relayed to clients.
        server.handleMessage(alice.client, buildRequestFrame(1, serializePlayerActions([{ id: 0, params: new Uint8Array() }])));
        server.handleMessage(bob.client, buildRequestFrame(1, serializePlayerActions([{ id: 0, params: new Uint8Array() }])));
        expect(binarySent(alice.socket).length).toBe(2);
        expect(binarySent(bob.socket).length).toBe(2);
    });

    test("writes a loadable replay when the last member leaves", () => {
        const replaysDir = __dirname + "/tmp-replays";
        rmSync(replaysDir, { recursive: true, force: true });
        mkdirSync(replaysDir, { recursive: true });
        const { config, manager, server } = setup(replaysDir);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        server.handleMessage(alice.client, buildRequestFrame(0, serializePlayerActions([{ id: 5, params: new Uint8Array([1, 2, 3]) }])));
        server.handleMessage(bob.client, buildRequestFrame(0, serializePlayerActions([{ id: 0, params: new Uint8Array() }])));
        server.handleMessage(bob.client, "taunt 2");
        server.handleMessage(bob.client, "privmsg #all :hello world");

        server.handleClose(alice.client);
        server.handleClose(bob.client);

        const files = readDir(replaysDir);
        expect(files.length).toBe(1);
        const text = readFileSync(files[0], "utf8");
        const lines = text.split("\n").filter(Boolean);
        expect(lines[0]).toBe("RA2TSREPL_v6");
        expect(lines[1]).toMatch(/^ENGINE \d+\.\d+( \d+)?$/);
        expect(lines[1]).toBe("ENGINE 0.83 0");
        expect(lines[2]).toMatch(/^g1-[\w-]+ \d+ .+$/);

        // Turn-actions event for turn 0 must be at tick (0+2)*S.
        const gameTurnMillis = computeGameTurnMillis(6);
        const networkTurnMillis = computeNetworkTurnMillis(33, gameTurnMillis);
        const subturns = networkTurnMillis / gameTurnMillis;
        const actionEvent = lines.find(line => line.match(/^(\d+)=0\|/));
        expect(actionEvent).toBeDefined();
        expect(actionEvent!.startsWith(`${2 * subturns}=0|`)).toBe(true);
        const payload = actionEvent!.split("|")[1];
        const parsed = parseAllPlayerActions(serverCodecDecode(payload));
        expect(parsed.get(0)).toEqual([{ id: 5, params: new Uint8Array([1, 2, 3]) }]);
        expect(parsed.get(1)).toEqual([{ id: 0, params: new Uint8Array() }]);

        expect(lines.some(line => line.startsWith(`${2 * subturns}=1|`))).toBe(true);
        expect(lines.some(line => line.startsWith(`${2 * subturns}=2|`))).toBe(true);
        expect(lines[lines.length - 1]).toMatch(/^END \d+$/);
    });

    test("does not save a replay when members leave before the game starts", () => {
        const replaysDir = __dirname + "/tmp-replays";
        rmSync(replaysDir, { recursive: true, force: true });
        const { config, manager, server } = setup(replaysDir);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleClose(alice.client);
        server.handleClose(bob.client);
        expect(readDir(replaysDir).length).toBe(0);
    });

    test("does not save a replay by default (recording is opt-in), but still relays actions", () => {
        const replaysDir = __dirname + "/tmp-replays";
        rmSync(replaysDir, { recursive: true, force: true });
        mkdirSync(replaysDir, { recursive: true });
        const config = loadConfig({ REPLAYS_DIR: replaysDir, GSERV_NET_RATE_MS: "33" });
        const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const server = new GservServer(config, manager);
        const instance = manager.create(["alice", "bob"], "ws://gserv");
        instance.gameopts = buildGameOpts(["alice", "bob"]);
        const alice = join(server, manager, instance, "alice");
        const bob = join(server, manager, instance, "bob");
        server.handleMessage(alice.client, "loaded 100");
        server.handleMessage(bob.client, "loaded 100");

        server.handleMessage(alice.client, buildRequestFrame(0, serializePlayerActions([{ id: 5, params: new Uint8Array([1, 2, 3]) }])));
        server.handleMessage(bob.client, buildRequestFrame(0, serializePlayerActions([{ id: 0, params: new Uint8Array() }])));

        expect(binarySent(alice.socket).length).toBe(1);
        expect(binarySent(bob.socket).length).toBe(1);

        server.handleClose(alice.client);
        server.handleClose(bob.client);
        expect(readDir(replaysDir).length).toBe(0);
    });
});

function readDir(dir: string): string[] {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    try {
        return readdirSync(dir).map(name => dir + "/" + name);
    }
    catch {
        return [];
    }
}

function serverCodecDecode(payload: string): Uint8Array {
    return new Uint8Array(Buffer.from(payload, "base64"));
}
