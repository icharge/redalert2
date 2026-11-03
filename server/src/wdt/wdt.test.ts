import { describe, expect, test } from "bun:test";
import {
    TERRITORY_RECORD_BYTES,
    TERRITORIES_PER_CONTINENT,
    decodeContainer,
    encodeContainer,
    encodeNack,
    readString,
    readU32,
} from "./codec";
import { WdtService } from "./service";
import { WdtTcpServer } from "./server";
import { handleWdt } from "./http";
import { parseWdtOpts } from "../server/WolServer";
import { applyWdtNativeResult } from "../http/nativeResults";
import { Database } from "bun:sqlite";
import { SqliteWdtStore } from "./store";

describe("WDT container codec", () => {
    test("round-trips tags, integers and strings with four-byte padding", () => {
        const packet = encodeContainer([
            { tag: "ABCD", value: Buffer.from([1, 2, 3, 4]) },
            { tag: "TEXT", value: Buffer.from("hello") },
            { tag: "ZERO", value: Buffer.alloc(0) },
        ]);
        expect(packet.readUInt16BE(0)).toBe(packet.length);
        const records = decodeContainer(packet);
        expect([...records.keys()]).toEqual(["ABCD", "TEXT", "ZERO"]);
        expect(readU32(records, "ABCD")).toBe(0x04030201);
        expect(readString(records, "TEXT")).toBe("hello");
    });

    test("a truncated container is rejected, not partially parsed", () => {
        const packet = encodeContainer([{ tag: "ABCD", value: Buffer.from("x") }]);
        expect(() => decodeContainer(packet.subarray(0, packet.length - 2))).toThrow();
    });

    test("NACK is a container with a single string record", () => {
        const records = decodeContainer(encodeNack("no cycle"));
        expect([...records.keys()]).toEqual(["NACK"]);
        expect(readString(records, "NACK")).toBe("no cycle");
    });
});

describe("WDT state packets", () => {
    const service = new WdtService({ edition: "ra2", now: () => 1_700_000_000_000 });

    test("the current packet has the tags the client's WDTState reads", () => {
        const records = decodeContainer(service.packet("current"));
        for (const tag of ["CRTK", "CYLN", "MPVC", "HSVC", "CMID", "CYID", "TICC", "WURL", "SDSC", "LDSC"]) {
            expect(records.has(tag)).toBe(true);
        }
        expect(readU32(records, "CRTK")).toBe(2); // RA2: allied, soviet, neutral
        expect(readU32(records, "TICC")).toBe(TERRITORIES_PER_CONTINENT);
        expect(records.get("MPVC")!.length).toBe(TERRITORIES_PER_CONTINENT * TERRITORY_RECORD_BYTES);
        expect(records.get("HSVC")!.length).toBe(Math.ceil((3 * TERRITORIES_PER_CONTINENT * 2) / 8));
        expect(records.get("CMID")!.length).toBe(1);
        expect(readU32(records, "CYID")).toBe(1);
    });

    test("the previous packet has TOTK and no current-only records", () => {
        service.advanceCycle();
        const records = decodeContainer(service.packet("previous"));
        expect(records.has("TOTK")).toBe(true);
        expect(records.has("CRTK")).toBe(false);
        expect(records.has("MPVC")).toBe(false);
        expect(records.has("TICC")).toBe(false);
        expect(readU32(records, "TOTK")).toBe(2);
        expect(readU32(records, "CYID")).toBe(1);
    });

    test("a fresh deployment still answers the previous-cycle request", () => {
        const fresh = new WdtService({ edition: "yr" });
        const records = decodeContainer(fresh.packet("previous"));
        expect(records.has("TOTK")).toBe(true);
        expect(records.has("MPVC")).toBe(false);
        expect(readU32(records, "CYID")).toBe(0);
    });
});

describe("WDT cycle service", () => {
    test("assignment prefers neutral territory and only one conflict closes", () => {
        let now = 1_000;
        const service = new WdtService({ edition: "yr", now: () => now++ });
        const conflict = service.assignConflict(0);
        expect(conflict.territoryId).toBe(10);
        expect(conflict.defender).toBe(3); // neutral row
        service.reportResult({ conflictId: conflict.id, winner: 0 });
        expect(service.cycle.territories[10].owner).toBe(0);
        expect(service.cycle.history).toHaveLength(1);
        expect(() => service.reportResult({ conflictId: conflict.id, winner: 0 })).toThrow(/closed/);
    });

    test("an own-territory pick falls back to a neutral territory", () => {
        const service = new WdtService({ edition: "ra2", now: () => 1_000 });
        // Territory 0 starts owned by the allied row (0); clicking it must not
        // abort the match, it attacks the automatic neutral pick instead.
        const conflict = service.assignConflictOrAuto(0, 0, "g-fallback");
        expect(conflict.territoryId).toBe(10);
        expect(conflict.defender).toBe(2);
        expect(service.conflictForGame("g-fallback")?.id).toBe(conflict.id);
        expect(() => service.assignConflict(0, 0)).toThrow(/already ours/);
    });

    test("a winner outside the conflict is rejected", () => {
        const service = new WdtService({ edition: "ra2" });
        const conflict = service.assignConflict(0, 11);
        expect(() => service.reportResult({ conflictId: conflict.id, winner: 1 })).toThrow(/not part/);
    });

    test("a game id assignment applies once, then rejects the duplicate report", () => {
        const service = new WdtService({ edition: "ra2", now: () => 1_000 });
        const conflict = service.assignConflict(0, 11, "g1-wdt");
        expect(conflict.gameId).toBe("g1-wdt");
        expect(service.conflictForGame("g1-wdt")?.id).toBe(conflict.id);
        service.reportResultByGame("g1-wdt", conflict.attacker);
        expect(service.cycle.territories[11].owner).toBe(conflict.attacker);
        expect(service.cycle.conflicts.find(c => c.id === conflict.id)?.closedAt).toBeDefined();
        expect(() => service.reportResultByGame("g1-wdt", conflict.defender)).toThrow(/closed/);
    });

    test("a native win settles the assigned conflict once, then rejects the duplicate", () => {
        const service = new WdtService({ edition: "ra2", now: () => 2_000 });
        const conflict = service.assignConflict(0, 11, "g2-wdt");
        const instance = {
            gameId: "g2-wdt",
            wdtConflictId: conflict.id,
            wdtSides: { ally: conflict.attacker, axis: conflict.defender },
        };
        const report = {
            players: [
                { name: "Ally", completionStatus: 256 },
                { name: "Axis", completionStatus: 512 },
            ],
        };
        expect(applyWdtNativeResult(service, instance, report, "g2-wdt"))
            .toEqual({ conflictId: conflict.id, winner: conflict.attacker });
        expect(service.cycle.territories[11].owner).toBe(conflict.attacker);
        expect(() => applyWdtNativeResult(service, instance, report, "g2-wdt")).toThrow(/closed/);
    });

    test("game options carry the WDT side and territory into STARTG", () => {
        expect(parseWdtOpts("0,0,2,...,WDS=1,WDT=11")).toEqual({ side: 1, territory: 11 });
        expect(parseWdtOpts("WDS=0")).toEqual({ side: 0, territory: undefined });
        expect(parseWdtOpts("0,0,2,no tags")).toBeUndefined();
        expect(parseWdtOpts(undefined)).toBeUndefined();
    });

    test("the rollover freezes the current map as the previous cycle", () => {
        const service = new WdtService({ edition: "ra2" });
        const conflict = service.assignConflict(0, 11);
        service.reportResult({ conflictId: conflict.id, winner: 0 });
        service.advanceCycle();
        const previous = decodeContainer(service.packet("previous"));
        expect(readU32(previous, "CYID")).toBe(1);
        const current = service.packet("current");
        expect(current.readUInt16BE(0)).toBe(current.length);
        expect(decodeContainer(current).has("CRTK")).toBe(true);
    });
});

describe("WDT admin and persistence", () => {
    test("admin actions require the guard; rollover, reset and enable work", async () => {
        const service = new WdtService({ edition: "ra2" });
        const admin = () => true;
        const denied = await handleWdt(new Request("http://x/wdt/admin/rollover", { method: "POST" }), service);
        expect(denied?.status).toBe(401);

        const roll = await handleWdt(new Request("http://x/wdt/admin/rollover", { method: "POST" }), service, admin);
        expect(roll?.status).toBe(200);
        expect(((await roll!.json()) as { cycle: { id: number } }).cycle.id).toBe(2);

        const reset = await handleWdt(new Request("http://x/wdt/admin/reset", { method: "POST" }), service, admin);
        expect(((await reset!.json()) as { cycle: { id: number } }).cycle.id).toBe(3);

        const enable = await handleWdt(new Request("http://x/wdt/admin/enable", {
            method: "POST",
            body: JSON.stringify({ enabled: false }),
        }), service, admin);
        expect(await enable!.json()).toEqual({ ok: true, enabled: false });
        expect(service.isEnabled()).toBe(false);
        const packet = await handleWdt(new Request("http://x/wdt/state"), service);
        expect(packet?.status).toBe(503);

        const on = await handleWdt(new Request("http://x/wdt/admin/enable", { method: "POST" }), service, admin);
        expect(await on!.json()).toEqual({ ok: true, enabled: true });
        expect((await handleWdt(new Request("http://x/wdt/state"), service))?.status).toBe(200);
    });

    test("SQLite keeps the cycle, closed conflict and history across services", () => {
        const db = new Database(":memory:");
        const store = new SqliteWdtStore(db);
        const first = new WdtService({ edition: "ra2", now: () => 5_000, store });
        const conflict = first.assignConflict(0, 11, "g7-wdt");
        first.reportResultByGame("g7-wdt", conflict.attacker);
        expect(first.cycle.history).toHaveLength(1);

        const reopened = new WdtService({ edition: "ra2", now: () => 6_000, store });
        expect(reopened.cycle.territories[11].owner).toBe(conflict.attacker);
        expect(reopened.cycle.history).toHaveLength(1);
        expect(reopened.conflictForGame("g7-wdt")?.closedAt).toBeDefined();
        expect(() => reopened.reportResultByGame("g7-wdt", conflict.attacker)).toThrow(/closed/);
        db.close();
    });
});

describe("WDT endpoints", () => {
    test("HTTP state serves the binary packet and status serves JSON", async () => {
        const service = new WdtService({ edition: "ra2" });
        const state = (await handleWdt(new Request("http://x/wdt/state?cycle=current"), service))!;
        expect(state.headers.get("Content-Type")).toBe("application/octet-stream");
        const records = decodeContainer(Buffer.from(await state.arrayBuffer()));
        expect(records.has("CRTK")).toBe(true);
        const status = (await handleWdt(new Request("http://x/wdt/status"), service))!;
        const json = await status.json() as { cycle: { id: number } };
        expect(json.cycle.id).toBe(1);
        expect(await handleWdt(new Request("http://x/other"), service)).toBeUndefined();
    });

    test("the native listener answers a text request with a decodable packet", async () => {
        const service = new WdtService({ edition: "ra2" });
        const server = new WdtTcpServer(service, { port: 0, idleTimeoutMs: 2000 });
        const { port } = await server.start();
        try {
            const packet = await new Promise<Buffer>((resolve, reject) => {
                const socket = Bun.connect({
                    hostname: "127.0.0.1",
                    port,
                    socket: {
                        open(socket) { socket.write("WDT CURRENT\n"); },
                        data(_socket, data) { resolve(Buffer.from(data)); },
                        error(_socket, error) { reject(error); },
                    },
                });
                setTimeout(() => reject(new Error("timeout")), 3000);
            });
            const records = decodeContainer(packet);
            expect(records.has("CRTK")).toBe(true);
        } finally {
            await server.close();
        }
    });

    test("the native listener serves the previous cycle and tagged/byte selectors", async () => {
        const service = new WdtService({ edition: "ra2" });
        const server = new WdtTcpServer(service, { port: 0, idleTimeoutMs: 2000 });
        const { port } = await server.start();
        const ask = (bytes: Buffer | string) => new Promise<Buffer>((resolve, reject) => {
            const socket = Bun.connect({
                hostname: "127.0.0.1",
                port,
                socket: {
                    open(socket) { socket.write(bytes); },
                    data(_socket, data) { resolve(Buffer.from(data)); },
                    error(_socket, error) { reject(error); },
                },
            });
            setTimeout(() => reject(new Error("timeout")), 3000);
        });
        try {
            // Text selector.
            expect(decodeContainer(await ask("WDT PREVIOUS\n")).has("TOTK")).toBe(true);
            // One-byte selector: 1 = previous.
            expect(decodeContainer(await ask(Buffer.from([1]))).has("TOTK")).toBe(true);
            // The tagged request the browser path uses: WREQ = 1.
            const tagged = encodeContainer([{ tag: "WREQ", value: Buffer.from([1, 0, 0, 0]) }]);
            expect(decodeContainer(await ask(tagged)).has("TOTK")).toBe(true);
            // A fixed 16-byte selector from the classic control still gets a
            // current packet instead of hanging until the idle timeout.
            const header = Buffer.alloc(16);
            header[0] = 0x12;
            expect(decodeContainer(await ask(header)).has("CRTK")).toBe(true);
        } finally {
            await server.close();
        }
    });
});

describe("WDT clicked territory", () => {
    test("a late click retargets the open conflict; owned or closed ones are ignored", () => {
        const service = new WdtService({ edition: "ra2", now: () => 1_000 });
        const conflict = service.assignConflict(0, undefined, "g1-wdt");
        // The start fell back to the automatic neutral pick (10).
        expect(conflict.territoryId).toBe(10);
        // The click was processed a moment later and names region 18.
        const moved = service.retargetConflict(conflict.id, 18, 0);
        expect(moved?.territoryId).toBe(18);
        expect(service.conflictForGame("g1-wdt")?.territoryId).toBe(18);
        // An own region is not a valid target, so the pick stands.
        expect(service.retargetConflict(conflict.id, 0, 0)).toBeUndefined();
        expect(service.conflictForGame("g1-wdt")?.territoryId).toBe(18);
        // After the result the conflict is closed and cannot move again.
        service.reportResult({ conflictId: conflict.id, winner: 0, gameId: "g1-wdt" });
        expect(service.retargetConflict(conflict.id, 11, 0)).toBeUndefined();
    });
});
