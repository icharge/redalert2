import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/auth/db";
import { MapStore, parseMapMetadata } from "../src/mapstore/MapStore";

function makeStore(): { store: MapStore; dir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "ra2-mapstore-"));
    const db = openDatabase(":memory:");
    const store = new MapStore(db, { mapsDir: dir, maxUploadBytes: 1024 * 1024 });
    return { store, dir };
}

const SAMPLE_MAP = `[Map]
Size=32,32,64,64
[Basic]
Name=Test Battleground
Official=no
GameMode=MeatGrinder, Standard
[Waypoints]
0=10,10
1=20,20
2=30,30
3=40,40
[Terrain]
0,0=Dirt
`;

describe("MapStore", () => {
    let store: MapStore;
    let dir: string;

    beforeEach(() => {
        ({ store, dir } = makeStore());
    });

    test("ingest stores blob, parses metadata, counts an upload", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const { record, deduplicated } = store.ingest(bytes, {
            filename: "testmap.map",
            username: "alice",
            source: "upload",
            visible: true,
        });
        expect(deduplicated).toBe(false);
        expect(record.filename).toBe("testmap.map");
        expect(record.title).toBe("Test Battleground");
        expect(record.maxPlayers).toBe(4);
        expect(record.official).toBe(false);
        expect(record.gameModes).toEqual(["MeatGrinder", "Standard"]);
        expect(record.uploads).toBe(1);
        expect(existsSync(path.join(dir, record.sha256))).toBe(true);
    });

    test("re-upload of identical bytes deduplicates and logs the event", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const first = store.ingest(bytes, { filename: "a.map", username: "alice", source: "upload", visible: true });
        const second = store.ingest(bytes, { filename: "b.map", username: "bob", source: "upload", visible: true });
        expect(second.deduplicated).toBe(true);
        expect(second.record.sha256).toBe(first.record.sha256);
        expect(second.record.uploads).toBe(2);
        expect(second.record.filename).toBe("a.map");
        const log = store.getUploadLog(first.record.sha256);
        expect(log.map(entry => entry.username)).toEqual(["bob", "alice"]);
        expect(store.counts()).toEqual({ total: 1, visible: 1 });
    });

    test("oversized uploads are rejected", () => {
        const store2 = new MapStore(new Database(":memory:"), { mapsDir: dir, maxUploadBytes: 10 });
        expect(() => store2.ingest(new Uint8Array(64), { filename: "big.map", username: "u", source: "upload", visible: true }))
            .toThrow(/exceeds maximum size/);
    });

    test("empty uploads are rejected", () => {
        expect(() => store.ingest(new Uint8Array(0), { filename: "e.map", username: "u", source: "upload", visible: true }))
            .toThrow(/Empty map file/);
    });

    test("ratings are per-user upserts with computed average", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const { record } = store.ingest(bytes, { filename: "m.map", username: "alice", source: "upload", visible: true });
        store.rate(record.sha256, "alice", 5);
        store.rate(record.sha256, "bob", 3);
        store.rate(record.sha256, "alice", 4);
        const stats = store.ratingStats(record.sha256);
        expect(stats.avg).toBe(3.5);
        expect(stats.count).toBe(2);
        expect(store.getUserRating(record.sha256, "alice")).toBe(4);
        expect(() => store.rate(record.sha256, "carol", 9)).toThrow(/between 1 and 5/);
    });

    test("list filters by query, sorts, paginates and respects visibility", () => {
        const enc = new TextEncoder();
        store.ingest(enc.encode(SAMPLE_MAP), { filename: "alpha.map", username: "u", source: "upload", visible: true });
        store.ingest(enc.encode(SAMPLE_MAP.replace("Test Battleground", "Beta Blitz")), { filename: "beta.map", username: "u", source: "upload", visible: false });
        const visible = store.list({});
        expect(visible.total).toBe(1);
        expect(visible.items[0]!.filename).toBe("alpha.map");
        const all = store.list({ includeHidden: true });
        expect(all.total).toBe(2);
        const beta = store.list({ query: "beta", includeHidden: true });
        expect(beta.total).toBe(1);
        expect(beta.items[0]!.filename).toBe("beta.map");
        const byName = store.getByFilename("ALPHA.MAP");
        expect(byName?.sha256).toBe(visible.items[0]!.sha256);
        const hiddenByName = store.getByFilename("beta.map");
        expect(hiddenByName).toBeUndefined();
        const hiddenByAdmin = store.getByFilename("beta.map", true);
        expect(hiddenByAdmin).toBeDefined();
    });

    test("transfer attach + getByGameId round-trips and dedups onto one blob", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const { record } = store.ingest(bytes, { filename: "m.map", username: "host", source: "transfer", visible: true });
        store.attachTransfer("game-123", record.sha256, "host");
        const byGame = store.getByGameId("game-123");
        expect(byGame?.sha256).toBe(record.sha256);
        expect(store.getByGameId("game-unknown")).toBeUndefined();
    });

    test("readBlob verifies content hash and download counts increment", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const { record } = store.ingest(bytes, { filename: "m.map", username: "u", source: "upload", visible: true });
        const read = store.readBlob(record);
        expect(read.length).toBe(bytes.length);
        store.countDownload(record);
        store.countDownload(store.getBySha256(record.sha256)!);
        expect(store.getBySha256(record.sha256)!.downloads).toBe(2);
    });

    test("delete removes rows, ratings, transfers and the blob", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const { record } = store.ingest(bytes, { filename: "m.map", username: "u", source: "upload", visible: true });
        store.attachTransfer("game-1", record.sha256, "u");
        store.rate(record.sha256, "u", 4);
        const blobPath = path.join(dir, record.sha256);
        expect(existsSync(blobPath)).toBe(true);
        expect(store.delete(record.sha256)).toBe(true);
        expect(store.getBySha256(record.sha256)).toBeUndefined();
        expect(store.getByGameId("game-1")).toBeUndefined();
        expect(existsSync(blobPath)).toBe(false);
        expect(store.delete(record.sha256)).toBe(false);
    });

    test("admin metadata edits persist", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const { record } = store.ingest(bytes, { filename: "m.map", username: "u", source: "upload", visible: true });
        expect(store.updateMeta(record.sha256, { title: "Renamed", official: true, gameModes: ["Standard"] })).toBe(true);
        const after = store.getBySha256(record.sha256)!;
        expect(after.title).toBe("Renamed");
        expect(after.official).toBe(true);
        expect(after.gameModes).toEqual(["Standard"]);
    });

    test("parseMapMetadata degrades gracefully on unknown content", () => {
        const meta = parseMapMetadata(new TextEncoder().encode("garbage, no sections here"));
        expect(meta.title).toBe("");
        expect(meta.maxPlayers).toBe(0);
        expect(meta.gameModes).toEqual(["standard"]);
    });

    test("sanitizes hostile filenames", () => {
        const bytes = new TextEncoder().encode(SAMPLE_MAP);
        const { record } = store.ingest(bytes, { filename: "../../etc/passwd.map", username: "u", source: "upload", visible: true });
        expect(record.filename).toBe("passwd.map");
    });
});
