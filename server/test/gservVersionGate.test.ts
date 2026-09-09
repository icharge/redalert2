import { describe, expect, test } from "bun:test";
import { GservServer, GservClient } from "../src/gserv/GservServer";
import { GservManager, GservInstance } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { FakeSocket, hasLine } from "./helpers";

function buildGameOpts(names: string[]): string {
    const optionsPart = "0,0,0,10000,50,0,0,0,1,0,0,0,SXNsYW5kIFdhcg==,8,1,100,mpdefault,abc,1,0,0,1,0";
    const playersPart = names.map((name, i) => `${name},1,${i + 1},${i + 1},1,0,0,0`).join(",");
    return `${optionsPart}:${playersPart}:@:,-1,-1,-1,-1,`;
}

function setup(env: Record<string, string> = {}) {
    const config = loadConfig(env);
    const manager = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const server = new GservServer(config, manager);
    const instance = manager.create(["alice"], "ws://gserv");
    instance.gameopts = buildGameOpts(["alice"]);
    return { config, manager, server, instance };
}

// Unlike the shared join() helper elsewhere (which omits the version/modHash
// tokens entirely to stay agnostic to this gate), this sends them explicitly
// so each test can exercise a specific version/modHash combination.
function joinWithVersion(server: GservServer, instance: GservInstance, nick: string, version: string, modHash: string): { socket: FakeSocket; client: GservClient } {
    const ticket = instance.tickets.get(nick)!;
    const socket = new FakeSocket();
    const client = server.handleOpen(socket);
    server.handleMessage(client, `ticket ${ticket}`);
    server.handleMessage(client, `join ${instance.gameId} ${version} ${modHash}`);
    return { socket, client };
}

const accepted = (socket: FakeSocket) => hasLine(socket, line => line.includes(" 400 "));
const versionMismatch = (socket: FakeSocket) => hasLine(socket, line => line.includes(" 406 ") && line.includes("version mismatch"));
const modHashMismatch = (socket: FakeSocket) => hasLine(socket, line => line.includes(" 406 ") && line.includes("mod hash mismatch"));

describe("GservServer join version gate", () => {
    test("lenient by default: any build hash is accepted once major.minor.patch matches", () => {
        // Default GAME_VERSION ("0.83.4") carries no git-hash suffix, so the
        // comparator falls back to patch-only matching -- this is what keeps
        // every existing deployment and test that doesn't configure
        // GAME_VERSION working exactly as before this change.
        const { server, instance } = setup();
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-a1b2c3d", "");
        expect(accepted(socket)).toBe(true);
        expect(versionMismatch(socket)).toBe(false);
    });

    test("lenient by default: a different build hash of the same patch is also accepted", () => {
        const { server, instance } = setup();
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-deadbeef", "");
        expect(accepted(socket)).toBe(true);
    });

    test("a different patch is rejected even in lenient mode", () => {
        const { server, instance } = setup();
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.2-a1b2c3d", "");
        expect(versionMismatch(socket)).toBe(true);
        expect(accepted(socket)).toBe(false);
    });

    test("a different major.minor is rejected", () => {
        const { server, instance } = setup();
        const { socket } = joinWithVersion(server, instance, "alice", "0.84.0-a1b2c3d", "");
        expect(versionMismatch(socket)).toBe(true);
    });

    test("strict when the operator configures an exact build: same version+hash is accepted", () => {
        // An operator opts into requiring the exact same build (appropriate
        // for deterministic lockstep, where even a same-patch build could
        // differ in game logic) by setting GAME_VERSION to a full
        // version+hash string.
        const { server, instance } = setup({ GAME_VERSION: "0.83.4-a1b2c3d" });
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-a1b2c3d", "");
        expect(accepted(socket)).toBe(true);
    });

    test("strict when the operator configures an exact build: a different hash of the same patch is rejected", () => {
        const { server, instance } = setup({ GAME_VERSION: "0.83.4-a1b2c3d" });
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-deadbeef", "");
        expect(versionMismatch(socket)).toBe(true);
        expect(accepted(socket)).toBe(false);
    });

    test("no version sent at all skips the check entirely, regardless of mode", () => {
        const { server, instance } = setup({ GAME_VERSION: "0.83.4-a1b2c3d" });
        const ticket = instance.tickets.get("alice")!;
        const socket = new FakeSocket();
        const client = server.handleOpen(socket);
        server.handleMessage(client, `ticket ${ticket}`);
        server.handleMessage(client, `join ${instance.gameId}`);
        expect(accepted(socket)).toBe(true);
        expect(versionMismatch(socket)).toBe(false);
    });
});

describe("GservServer join modHash gate", () => {
    test("unconfigured expectedModHash accepts any modHash, including an empty one", () => {
        const { server, instance } = setup();
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-a1b2c3d", "");
        expect(accepted(socket)).toBe(true);
    });

    test("a matching modHash is accepted when expectedModHash is configured", () => {
        const { server, instance } = setup({ EXPECTED_MOD_HASH: "1234567890" });
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-a1b2c3d", "1234567890");
        expect(accepted(socket)).toBe(true);
        expect(modHashMismatch(socket)).toBe(false);
    });

    test("a mismatched modHash is rejected when expectedModHash is configured", () => {
        const { server, instance } = setup({ EXPECTED_MOD_HASH: "1234567890" });
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-a1b2c3d", "9999999999");
        expect(modHashMismatch(socket)).toBe(true);
        expect(accepted(socket)).toBe(false);
    });

    test("an empty modHash is rejected when expectedModHash is configured", () => {
        // Guards against the regression this whole gate used to be silently
        // exposed to: GameScreen (the real join call site) used to always
        // send an empty modHash regardless of the client's actual rules, so
        // any deployment that configured EXPECTED_MOD_HASH would have
        // rejected every real player. Fixed on the client side (GameScreen
        // now reads Engine.getModHashString() live); this test pins the
        // server-side gate's half of that contract.
        const { server, instance } = setup({ EXPECTED_MOD_HASH: "1234567890" });
        const { socket } = joinWithVersion(server, instance, "alice", "0.83.4-a1b2c3d", "");
        expect(modHashMismatch(socket)).toBe(true);
    });
});
