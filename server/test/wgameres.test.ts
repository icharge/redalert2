import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { handleHttp, HttpDeps } from "../src/http/routes";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { loadConfig, ServerConfig } from "../src/config";
import { MemoryStorage } from "../src/storage/MemoryStorage";
import { SqliteStorage } from "../src/storage/SqliteStorage";
import { LadderService } from "../src/ladder/LadderService";
import { GservManager, GservInstance } from "../src/gserv/GservManager";
import { WolServer } from "../src/server/WolServer";
import { FakeSocket, hasLine } from "./helpers";
import { decodeGameRes, GameResType } from "../src/ladder/gameResCodec";

const RA2_SKU = 16640;

function makeTestLogger() {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    } as any;
}

interface Env {
    config: ServerConfig;
    deps: HttpDeps;
    sessions: SessionManager;
    storage: ReturnType<typeof makeStorage>;
}

function makeStorage() {
    return new MemoryStorage();
}

function setup(): Env {
    const config = loadConfig({ MIN_REPORT_DURATION_SECONDS: "120" });
    const storage = makeStorage();
    const accounts = new AccountStore(storage, config);
    const sessions = new SessionManager(storage, config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const wol = new WolServer(config, sessions, accounts, gservs);
    const ladder = new LadderService(storage, makeTestLogger(), {
        startingRating: config.startingRating,
        placementMatches: config.placementMatches,
    });
    const deps: HttpDeps = { accounts, sessions, ladder, gservs, wol };
    return { config, deps, sessions, storage };
}

async function registerAndLogin(deps: HttpDeps, user: string): Promise<string> {
    const reg = await handleHttp(
        new Request("http://localhost/register", { method: "POST", body: JSON.stringify({ user, pass: "password123" }) }),
        deps,
        loadConfig({}),
    );
    expect(reg.status).toBe(200);
    const login = await handleHttp(
        new Request("http://localhost/login", { method: "POST", body: JSON.stringify({ user, pass: "password123" }) }),
        deps,
        loadConfig({}),
    );
    const data: any = await login.json();
    return data.sessionToken as string;
}

// Builds a ranked gserv instance exactly like the matchmaking bot does.
function makeRankedInstance(gservs: GservManager, players: string[], ladderType = "1v1"): GservInstance {
    return gservs.create(players, "ws://test.local/gserv", { ranked: true, ladderType });
}

// --- game res packet fixture (mirrors GameRes.toBinary on the client) ---
const FIELD_BOOLEAN = 2;
const FIELD_INT = 6;
const FIELD_STRING = 7;

interface Field {
    name: string;
    type: number;
    value: number | boolean | string;
}

function pushField(target: number[], name: string, type: number, value: number | boolean | string): void {
    target.push(...[...Buffer.from(name, "ascii"), 0, 0, 0, 0].slice(0, 4));
    const typeBytes = Buffer.alloc(2);
    typeBytes.writeUInt16BE(type);
    target.push(...typeBytes);
    if (type === FIELD_BOOLEAN) {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(1);
        target.push(...length, value ? 1 : 0, 0, 0, 0);
        return;
    }
    if (type === FIELD_STRING) {
        const text = String(value);
        const lengthBytes = Buffer.alloc(2);
        lengthBytes.writeUInt16BE(text.length + 1);
        target.push(...lengthBytes);
        const padded = Buffer.alloc(4 * Math.ceil((text.length + 1) / 4));
        Buffer.from(text, "utf8").copy(padded);
        target.push(...padded);
        return;
    }
    const lengthBytes = Buffer.alloc(2);
    lengthBytes.writeUInt16BE(4);
    const valueBytes = Buffer.alloc(4);
    valueBytes.writeUInt32BE(Number(value));
    target.push(...lengthBytes, ...valueBytes);
}

function buildPacket(fields: Field[]): string {
    const body: number[] = [];
    for (const field of fields) {
        pushField(body, field.name, field.type, field.value);
    }
    const header = Buffer.alloc(4);
    header.writeUInt16BE(body.length + 4, 0);
    header.writeUInt16BE(0, 2);
    return Buffer.from([...header, ...body]).toString("base64");
}

function str(name: string, value: string): Field {
    return { name, type: FIELD_STRING, value };
}

function int(name: string, value: number): Field {
    return { name, type: FIELD_INT, value };
}

function bool(name: string, value: boolean): Field {
    return { name, type: FIELD_BOOLEAN, value };
}

function buildReport(overrides: Record<string, number | boolean | string> = {}): string {
    const merged = { gameId: "g1-test", account: "alice", duration: 300, finished: true, oosy: false, shrt: false, trny: true, cmp0: GameResType.Win, cmp1: GameResType.Loss, ...overrides };
    return buildPacket([
        int("PLRS", 2),
        int("DURA", merged.duration as number),
        bool("FINI", merged.finished as boolean),
        int("GSKU", RA2_SKU),
        bool("OOSY", merged.oosy as boolean),
        bool("SHRT", merged.shrt as boolean),
        bool("TRNY", merged.trny as boolean),
        str("GMID", merged.gameId as string),
        str("SNAM", merged.account as string),
        str("NAM0", "alice"),
        int("CMP0", merged.cmp0 as number),
        str("NAM1", "bob"),
        int("CMP1", merged.cmp1 as number),
    ]);
}

async function postReport(env: Env, token: string, body: string, path = `/wgameres/${RA2_SKU}`) {
    return await handleHttp(
        new Request(`http://localhost${path}`, {
            method: "POST",
            body,
            headers: { authorization: `Bearer ${token}` },
        }),
        env.deps,
        env.config,
    );
}

describe("POST /wgameres/{sku}", () => {
    test("requires a session token", async () => {
        const env = setup();
        const res = await postReport(env, "", buildReport());
        expect(res.status).toBe(401);
    });

    test("rejects an invalid body", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const res = await postReport(env, token, "not base64 !!!");
        expect(res.status).toBe(400);
    });

    test("rejects reports for unknown or unranked instances", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const unknown = await postReport(env, token, buildReport());
        expect(unknown.status).toBe(404);

        makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        makeRankedInstance(env.deps.gservs, ["carol", "dave"]); // different gameId
        const unranked = env.deps.gservs.create(["alice", "bob"], "ws://test.local/gserv");
        const report = buildReport({ gameId: unranked.gameId });
        const res = await postReport(env, token, report);
        expect(res.status).toBe(404);
    });

    test("rejects when the reporter account does not match the packet SNAM", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "carol");
        makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        const res = await postReport(env, token, buildReport());
        expect(res.status).toBe(400);
    });

    test("rejects roster mismatches (observers or strangers)", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        // Report includes a stranger who is not in the instance roster.
        const report = buildPacket([
            int("PLRS", 2),
            int("DURA", 300),
            bool("FINI", true),
            int("GSKU", RA2_SKU),
            bool("OOSY", false),
            bool("SHRT", false),
            bool("TRNY", true),
            str("GMID", instance.gameId),
            str("SNAM", "alice"),
            str("NAM0", "alice"),
            int("CMP0", GameResType.Win),
            str("NAM1", "mallory"),
            int("CMP1", GameResType.Loss),
        ]);
        const res = await postReport(env, token, report);
        expect(res.status).toBe(400);
    });

    test("scores a valid report and returns the 730 payload", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        const res = await postReport(env, token, buildReport({ gameId: instance.gameId }));
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.gameId).toBe(instance.gameId);
        expect(data.players).toHaveLength(2);
        const alice = data.players.find((p: any) => p.name === "alice");
        expect(alice.resultType).toBe(0);
        expect(alice.mmr.gain).toBeGreaterThan(0);
        expect(alice.points.value).toBeGreaterThanOrEqual(1000);
    });

    test("duplicate reports are a no-op", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        const body = buildReport({ gameId: instance.gameId });
        const first = await postReport(env, token, body);
        const second = await postReport(env, token, body);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const data: any = await second.json();
        expect(data.gameId).toBe(instance.gameId);
        // Standings only moved once.
        const profiles = env.deps.ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"]);
        expect(profiles![0].placementMatchesLeft).toBe(9);
    });

    test("rejects non-tournament, unfinished, out-of-sync and short reports", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        const gameId = instance.gameId;

        expect((await postReport(env, token, buildReport({ gameId, trny: false }))).status).toBe(400);
        expect((await postReport(env, token, buildReport({ gameId, finished: false }))).status).toBe(400);
        expect((await postReport(env, token, buildReport({ gameId, oosy: true }))).status).toBe(400);
        expect((await postReport(env, token, buildReport({ gameId, shrt: true }))).status).toBe(400);
        expect((await postReport(env, token, buildReport({ gameId, duration: 119 }))).status).toBe(400);
        // Nothing was scored.
        const profiles = env.deps.ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"]);
        expect(profiles![0].placementMatchesLeft).toBe(10);
    });

    test("rejects conflicting outcome reports without scoring", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        const res = await postReport(env, token, buildReport({ gameId: instance.gameId, cmp0: GameResType.Win, cmp1: GameResType.Win }));
        expect(res.status).toBe(400);
        const profiles = env.deps.ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"]);
        expect(profiles![0].placementMatchesLeft).toBe(10);
    });

    test("pushes 730 to every player with an active WOL session", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob"]);

        // Fake WOL sockets for both players (nick == account name).
        const aliceSocket = new FakeSocket();
        const bobSocket = new FakeSocket();
        const aliceUser = env.deps.wol.handleOpen(aliceSocket);
        const bobUser = env.deps.wol.handleOpen(bobSocket);
        aliceUser.nick = "alice";
        bobUser.nick = "bob";
        aliceUser.authenticated = true;
        bobUser.authenticated = true;
        env.deps.wol.users.set("alice", aliceUser);
        env.deps.wol.users.set("bob", bobUser);

        const res = await postReport(env, token, buildReport({ gameId: instance.gameId }));
        expect(res.status).toBe(200);

        expect(hasLine(aliceSocket, line => line.includes(" 730 alice :"))).toBe(true);
        expect(hasLine(bobSocket, line => line.includes(" 730 bob :"))).toBe(true);
        const line = aliceSocket.lines().find(l => l.includes(" 730 "))!;
        const payload = JSON.parse(Buffer.from(line.split(":")[line.split(":").length - 1], "base64").toString("utf8"));
        expect(payload.gameId).toBe(instance.gameId);
        expect(payload.players).toHaveLength(2);
        expect(payload.players.find((p: any) => p.name === "alice").resultType).toBe(0);
    });

    test("accepts the 2v2 ladder type", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob", "carol", "dave"], "2v2-random");
        const body = buildPacket([
            int("PLRS", 4),
            int("DURA", 300),
            bool("FINI", true),
            int("GSKU", RA2_SKU),
            bool("OOSY", false),
            bool("SHRT", false),
            bool("TRNY", true),
            str("GMID", instance.gameId),
            str("SNAM", "alice"),
            str("NAM0", "alice"),
            int("CMP0", GameResType.Win),
            str("NAM1", "bob"),
            int("CMP1", GameResType.Win),
            str("NAM2", "carol"),
            int("CMP2", GameResType.Loss),
            str("NAM3", "dave"),
            int("CMP3", GameResType.Loss),
        ]);
        const res = await postReport(env, token, body);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.players).toHaveLength(4);
    });

    test("expired instances can no longer be reported", async () => {
        const env = setup();
        const token = await registerAndLogin(env.deps, "alice");
        const instance = makeRankedInstance(env.deps.gservs, ["alice", "bob"]);
        instance.endedAt = Math.floor(Date.now() / 1000) - 10 * 60 - 1;
        const res = await postReport(env, token, buildReport({ gameId: instance.gameId }));
        expect(res.status).toBe(404);
    });
});
