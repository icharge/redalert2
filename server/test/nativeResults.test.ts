import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { decodeNativeGameRes } from "../src/ladder/nativeGameRes";
import { MemoryStorage } from "../src/storage/MemoryStorage";
import { SqliteStorage } from "../src/storage/SqliteStorage";
import { LadderService } from "../src/ladder/LadderService";
import { handleHttp } from "../src/http/routes";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { GservManager } from "../src/gserv/GservManager";
import { WolServer } from "../src/server/WolServer";
import { loadConfig } from "../src/config";

// Synthetic native FieldClass packet: one-byte flags, padded strings and blobs.
function field(name: string, type: number, bytes: Uint8Array): Buffer {
    const out = Buffer.alloc(8 + Math.ceil(bytes.length / 4) * 4);
    out.write(name); out.writeUInt16BE(type, 4); out.writeUInt16BE(bytes.length, 6);
    out.set(bytes, 8); return out;
}
function int(name: string, value: number): Buffer {
    const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return field(name, 6, bytes);
}
function flag(name: string, value: boolean): Buffer { return field(name, 2, new Uint8Array([+value])); }
function str(name: string, value: string): Buffer { return field(name, 7, Buffer.from(value + "\0", "latin1")); }
function packet(fields: Buffer[]): Buffer {
    const out = Buffer.concat([Buffer.alloc(4), ...fields]); out.writeUInt16BE(out.length); return out;
}
function report(options: { sku?: number; id?: number; finished?: boolean; reversed?: boolean; ai?: boolean; playing?: boolean } = {}): Buffer {
    return packet([
        int("IDNO", options.id ?? 1), int("GSKU", options.sku ?? 16640), flag("FINI", options.finished ?? true),
        flag("OOSY", false), int("DURA", 300), str("SCEN", "Test Map"),
        int("PLRS", options.ai ? 3 : 2), int("AIPL", options.ai ? 1 : 0),
        str("NAM0", "alice"), int("CMP0", options.playing ? 8 : options.reversed ? 512 : 256),
        str("NAM1", "bob"), int("CMP1", options.reversed ? 256 : 528),
        ...(options.ai ? [str("NAM2", "Computer"), int("CMP2", 512)] : []),
        int("CRD0", 1200), field("INB0", 20, new Uint8Array([0, 0, 0, 2, 0, 0, 0, 3])),
        str("ACCO", "private-account-value"), int("IPA0", 0x01020304), str("ZZZZ", "unknown-secret"),
    ]);
}

test("decodes both native editions and preserves safe statistics while redacting account/IP/unknown fields", () => {
    for (const sku of [16640, 18688]) {
        const decoded = decodeNativeGameRes(report({ sku }));
        expect(decoded).toMatchObject({ gameNumber: 1, sku, finished: true, duration: 300, mapName: "Test Map" });
        expect(decoded.players[0]).toMatchObject({ name: "alice", completionStatus: 256 });
        expect(decoded.fields.CRD0).toBe(1200);
        expect(decoded.fields.INB0).toEqual([0, 0, 0, 2, 0, 0, 0, 3]);
        expect(decoded.fields).not.toHaveProperty("ACCO");
        const saved = Buffer.from(decoded.packetBase64, "base64").toString("latin1");
        expect(saved).not.toContain("ACCO"); expect(saved).not.toContain("IPA0"); expect(saved).not.toContain("unknown-secret");
    }
});

test("rejects invalid field boundaries, duplicates, types, missing fields and oversized packets", () => {
    const bad = report(); bad.writeUInt16BE(0x7fff, 10);
    for (const bytes of [report().subarray(0, 10), bad, packet([int("IDNO", 1)]),
        packet([int("IDNO", 1), int("IDNO", 2)]), packet([field("IDNO", 99, new Uint8Array(4))]), new Uint8Array(32769)]) {
        expect(() => decodeNativeGameRes(bytes)).toThrow();
    }
});

for (const engine of ["memory", "sqlite"] as const) describe(engine, () => {
    function setup() {
        const storage = engine === "memory" ? new MemoryStorage() : new SqliteStorage(new Database(":memory:"));
        const config = loadConfig({});
        const log = { level: "error" as const, debug() {}, info() {}, warn() {}, error() {} };
        const ladder = new LadderService(storage, log);
        const accounts = new AccountStore(storage, config);
        const sessions = new SessionManager(storage, config.sessionTtlSeconds);
        storage.createAccount("alice", "unused-hash", Date.now());
        const token = sessions.create("alice");
        const gservs = new GservManager({ id: "gs", url: "ws://test/gserv" });
        const instance = gservs.create(["alice", "bob"], "ws://test/gserv", { nativeSku: 16640 });
        const wol = new WolServer(config, sessions, accounts, gservs);
        const deps = { ladder, accounts, sessions, gservs, wol };
        const post = (body: Uint8Array, auth = token, gameId = instance.gameId) => handleHttp(new Request(`http://localhost/native-results/${gameId}`, {
            method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/octet-stream" }, body,
        }), deps, config);
        return { storage, ladder, instance, post };
    }

    test("archives reports idempotently, preserves conflicts and terminal summaries, and never changes standings", async () => {
        const env = setup();
        try {
            expect((await env.post(report())).status).toBe(200);
            expect((await env.post(report())).status).toBe(200);
            expect(env.ladder.getMatch(env.instance.gameId)).toMatchObject({ scored: false, duration: 300, mapName: "Test Map", nativeReports: [expect.objectContaining({ reporter: "alice", source: "native-client" })] });
            expect((await env.post(report({ finished: false }))).status).toBe(200);
            expect(env.ladder.getMatch(env.instance.gameId)?.players[0].resultType).toBe(0);
            expect((await env.post(report({ reversed: true }))).status).toBe(200);
            expect(env.ladder.getMatch(env.instance.gameId)).toMatchObject({ disputed: true, nativeReports: expect.any(Array) });
            expect(env.storage.countLadderMatches()).toBe(1);
            expect(env.storage.countStandingPlayers()).toBe(0);
            expect(env.ladder.getPlayerHistory("alice", undefined, undefined, 10)?.matches).toHaveLength(1);
        } finally { env.storage.close(); }
    });

    test("a provisional finished report does not prevent a later complete result", async () => {
        const env = setup();
        try {
            expect((await env.post(report({ playing: true }))).status).toBe(200);
            expect((await env.post(report())).status).toBe(200);
            expect(env.ladder.getMatch(env.instance.gameId)).toMatchObject({ disputed: false, players: [expect.objectContaining({ resultType: 0 }), expect.objectContaining({ resultType: 1 })] });
        } finally { env.storage.close(); }
    });

    test("ranked rows are protected and expired/oversized reports are refused", async () => {
        const env = setup();
        try {
            expect((await env.post(new Uint8Array(32769))).status).toBe(413);
            env.instance.endedAt = 1;
            expect((await env.post(report())).status).toBe(410);
            env.instance.endedAt = undefined;
            env.storage.insertLadderMatch({ gameId: env.instance.gameId, seasonId: 1, ladderType: "1v1", reportedAt: 1, payload: '{"players":[]}', replayPath: "", scored: true });
            expect((await env.post(report())).status).toBe(409);
            expect(env.storage.getLadderMatch(env.instance.gameId)?.payload).toBe('{"players":[]}');
        } finally { env.storage.close(); }
    });

    test("validates authenticated reporter, match context, ID, edition, body and roster", async () => {
        const env = setup();
        try {
            expect((await env.post(report(), "bad-token")).status).toBe(401);
            expect((await env.post(report(), undefined, "unknown")).status).toBe(404);
            expect((await env.post(report({ id: 2 }))).status).toBe(400);
            expect((await env.post(report({ sku: 18688 }))).status).toBe(400);
            expect((await env.post(new Uint8Array([1, 2]))).status).toBe(400);
            env.instance.players = ["mallory", "bob"];
            expect((await env.post(report())).status).toBe(403);
            env.instance.players = ["alice", "carol"];
            expect((await env.post(report())).status).toBe(400);
            env.instance.players = ["alice", "bob"];
            expect((await env.post(report({ ai: true }))).status).toBe(200);
        } finally { env.storage.close(); }
    });
});
