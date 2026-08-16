import { describe, expect, test } from "bun:test";
import { handleHttp, HttpDeps } from "../src/http/routes";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { loadConfig, ServerConfig } from "../src/config";
import { MemoryStorage } from "../src/storage/MemoryStorage";
import { LadderService, WolGameReportResult } from "../src/ladder/LadderService";
import { GservManager } from "../src/gserv/GservManager";
import { WolServer } from "../src/server/WolServer";

const RA2_SKU = 16640;

function makeTestLogger() {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    } as any;
}

function setup(): { config: ServerConfig; deps: HttpDeps; ladder: LadderService } {
    const config = loadConfig({});
    const storage = new MemoryStorage();
    const accounts = new AccountStore(storage, config);
    const sessions = new SessionManager(storage, config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const wol = new WolServer(config, sessions, accounts, gservs);
    const ladder = new LadderService(storage, makeTestLogger(), {
        startingRating: config.startingRating,
        placementMatches: config.placementMatches,
    });
    const deps: HttpDeps = { accounts, sessions, ladder, gservs, wol };
    return { config, deps, ladder };
}

function get(config: ServerConfig, deps: HttpDeps, path: string) {
    return handleHttp(new Request(`http://localhost${path}`), deps, config);
}

function post(config: ServerConfig, deps: HttpDeps, path: string, body: unknown) {
    return handleHttp(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }), deps, config);
}

describe("ladder routes", () => {
    test("GET /ladder/{sku} lists season slugs", async () => {
        const { config, deps } = setup();
        const res = await get(config, deps, `/ladder/${RA2_SKU}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(["current"]);
    });

    test("GET /ladder/{sku} 404s for unknown sku", async () => {
        const { config, deps } = setup();
        const res = await get(config, deps, "/ladder/999");
        expect(res.status).toBe(404);
    });

    test("GET /ladder/{sku}/{season} returns season details", async () => {
        const { config, deps } = setup();
        const res = await get(config, deps, `/ladder/${RA2_SKU}/current?locale=en-US`);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.name).toBe("Season 1");
        expect(typeof data.startTime).toBe("string");
        expect(typeof data.endTime).toBe("string");
        expect(data.ladders).toEqual([
            { id: "1v1", type: "1v1", name: "1v1" },
            { id: "2v2-random", type: "2v2-random", name: "2v2 Random" },
        ]);
        expect(data.totalRankedPlayers).toEqual([
            { ladderType: "1v1", value: 0 },
            { ladderType: "2v2-random", value: 0 },
        ]);
    });

    test("GET /ladder/{sku}/{season} 404s for unknown seasons", async () => {
        const { config, deps } = setup();
        expect((await get(config, deps, `/ladder/${RA2_SKU}/nope`)).status).toBe(404);
        expect((await get(config, deps, `/ladder/${RA2_SKU}/999`)).status).toBe(404);
    });

    test("POST listsearch returns placement boxes and profiles", async () => {
        const { config, deps, ladder } = setup();
        ladder.recordMatch({ sku: RA2_SKU, gameId: "g-1", ladderType: "1v1", duration: 300, players: [
            { name: "alice", resultType: WolGameReportResult.Win },
            { name: "bob", resultType: WolGameReportResult.Loss },
        ] });
        const res = await post(config, deps, `/ladder/${RA2_SKU}/1v1/current/listsearch`, { players: ["alice", "bob", "carol"], locale: "en-US" });
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data).toHaveLength(3);
        expect(data[0]).toMatchObject({ name: "alice", placementMatchesLeft: 9 });
        expect(data[2]).toEqual({ name: "carol", placementMatchesLeft: 10 });
    });

    test("POST listsearch 404s for unknown ladder type or season", async () => {
        const { config, deps } = setup();
        expect((await post(config, deps, `/ladder/${RA2_SKU}/bogus/current/listsearch`, { players: [] })).status).toBe(404);
        expect((await post(config, deps, `/ladder/${RA2_SKU}/1v1/nope/listsearch`, { players: [] })).status).toBe(404);
    });

    test("POST rungsearch returns a paged page and 404s for empty ladders", async () => {
        const { config, deps, ladder } = setup();
        const empty = await post(config, deps, `/ladder/${RA2_SKU}/1v1/current/rungsearch`, { ladderId: "1v1", start: 1, count: 20 });
        expect(empty.status).toBe(404);

        for (let i = 0; i < 10; i++) {
            const name = `p${i}`;
            for (let j = 0; j < 10; j++) {
                ladder.recordMatch({ sku: RA2_SKU, gameId: `g-${i}-${j}`, ladderType: "1v1", duration: 300, players: [
                    { name, resultType: WolGameReportResult.Win },
                    { name: `feeder${j}`, resultType: WolGameReportResult.Loss },
                ] });
            }
        }
        const res = await post(config, deps, `/ladder/${RA2_SKU}/1v1/current/rungsearch`, { ladderId: "1v1", start: 1, count: 5 });
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.totalCount).toBe(20);
        expect(data.records).toHaveLength(5);
        expect(data.records[0]).toMatchObject({ rank: 1, wins: 10, losses: 0 });
        expect(data.records[0].rankType).toBeGreaterThanOrEqual(1);
    });

    test("POST rungsearch rejects ladderId mismatches", async () => {
        const { config, deps, ladder } = setup();
        ladder.recordMatch({ sku: RA2_SKU, gameId: "g-1", ladderType: "1v1", duration: 300, players: [
            { name: "alice", resultType: WolGameReportResult.Win },
            { name: "bob", resultType: WolGameReportResult.Loss },
        ] });
        const res = await post(config, deps, `/ladder/${RA2_SKU}/1v1/current/rungsearch`, { ladderId: "2v2-random", start: 1, count: 20 });
        expect(res.status).toBe(404);
    });

    test("routes answer preflight with CORS headers", async () => {
        const { config, deps } = setup();
        const res = await handleHttp(
            new Request(`http://localhost/ladder/${RA2_SKU}/1v1/current/rungsearch`, {
                method: "OPTIONS",
                headers: { Origin: "http://localhost:5173" },
            }),
            deps,
            config,
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    });
});
