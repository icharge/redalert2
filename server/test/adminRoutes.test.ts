import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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

function setup(): { config: ServerConfig; deps: HttpDeps; ladder: LadderService; sessions: SessionManager } {
    const config = loadConfig({ ADMIN_USERNAMES: "root,admin" });
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
    return { config, deps, ladder, sessions };
}

async function adminToken(sessions: SessionManager, username: string): Promise<string> {
    return sessions.create(username);
}

async function get(config: ServerConfig, deps: HttpDeps, path: string, token: string) {
    return await handleHttp(
        new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }),
        deps,
        config,
    );
}

async function post(config: ServerConfig, deps: HttpDeps, path: string, token: string, body: unknown = {}) {
    return await handleHttp(
        new Request(`http://localhost${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }),
        deps,
        config,
    );
}

function scoreMatches(ladder: LadderService, count: number): void {
    for (let i = 0; i < count; i++) {
        for (let j = 0; j < 10; j++) {
            ladder.recordMatch({
                sku: RA2_SKU,
                gameId: `g-${i}-${j}`,
                ladderType: "1v1",
                duration: 300,
                mapName: "Island War",
                players: [
                    { name: `p${i}`, resultType: WolGameReportResult.Win },
                    { name: `feeder${j}`, resultType: WolGameReportResult.Loss },
                ],
            });
        }
    }
}

describe("admin routes", () => {
    test("rejects requests without a valid token", async () => {
        const { config, deps } = setup();
        const res = await handleHttp(new Request("http://localhost/admin/dashboard"), deps, config);
        expect(res.status).toBe(401);
    });

    test("rejects non-admin sessions", async () => {
        const { config, deps, sessions } = setup();
        const token = await adminToken(sessions, "player1");
        const res = await get(config, deps, "/admin/dashboard", token);
        expect(res.status).toBe(401);
    });

    test("dashboard returns headline stats and top-10 per ladder", async () => {
        const { config, deps, ladder } = setup();
        scoreMatches(ladder, 5);
        const token = await adminToken(deps.sessions, "root");
        const res = await get(config, deps, "/admin/dashboard", token);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.players).toBe(15);
        expect(data.matchesTotal).toBe(50);
        expect(data.ladders).toHaveLength(2);
        const ladder1v1 = data.ladders.find((l: any) => l.ladderType === "1v1");
        expect(ladder1v1.top10).toHaveLength(5);
        expect(ladder1v1.top10[0]).toMatchObject({ rank: 1, wins: 10 });
        expect(data.seasons.some((s: any) => s.isCurrent)).toBe(true);
    });

    test("seasons list shows per-season stats", async () => {
        const { config, deps, ladder } = setup();
        scoreMatches(ladder, 2);
        const token = await adminToken(deps.sessions, "root");
        const res = await get(config, deps, "/admin/seasons", token);
        const data: any = await res.json();
        // One season per known sku (16640 + 18688); the matches recorded above
        // land in the 16640 season.
        expect(data).toHaveLength(2);
        const season = data.find((s: any) => s.sku === RA2_SKU);
        expect(season).toMatchObject({ id: 1, name: "Season 1", sku: RA2_SKU, isCurrent: true });
        expect(season.rankedPlayers).toMatchObject({ "1v1": 2, "2v2-random": 0 });
        expect(season.matches).toMatchObject({ "1v1": 20 });
    });

    test("creates a season that becomes current and closes the previous one", async () => {
        const { config, deps, sessions } = setup();
        const token = await adminToken(sessions, "root");
        const created = await post(config, deps, "/admin/seasons", token, { name: "Season 2", sku: RA2_SKU });
        expect(created.status).toBe(201);
        const data: any = await created.json();
        expect(data.id).toBe(2);
        expect(data.isCurrent).toBe(true);

        const seasons = await get(config, deps, "/admin/seasons", token);
        const list: any = await seasons.json();
        expect(list.find((s: any) => s.sku === RA2_SKU && s.id === 1).isCurrent).toBe(false);
        expect(list.find((s: any) => s.sku === RA2_SKU && s.id === 2).isCurrent).toBe(true);

        const closed = await post(config, deps, `/admin/seasons/1/close?sku=${RA2_SKU}`, token);
        expect(closed.status).toBe(200);
        const after = await get(config, deps, "/admin/seasons", token);
        const afterList: any = await after.json();
        expect(afterList.find((s: any) => s.sku === RA2_SKU && s.id === 1).status).toBe("closed");
    });

    test("season creation validates input", async () => {
        const { config, deps, sessions } = setup();
        const token = await adminToken(sessions, "root");
        expect((await post(config, deps, "/admin/seasons", token, { name: "", sku: RA2_SKU })).status).toBe(400);
        expect((await post(config, deps, "/admin/seasons", token, { name: "x".repeat(41), sku: RA2_SKU })).status).toBe(400);
        expect((await post(config, deps, "/admin/seasons", token, { name: "Bad", sku: 999 })).status).toBe(400);
    });

    test("recent matches include the decoded payload with map name", async () => {
        const { config, deps, ladder, sessions } = setup();
        scoreMatches(ladder, 1);
        const token = await adminToken(sessions, "root");
        const res = await get(config, deps, "/admin/matches?limit=50", token);
        const data: any = await res.json();
        expect(data).toHaveLength(10);
        expect(data[0]).toMatchObject({
            ladderType: "1v1",
            duration: 300,
            mapName: "Island War",
            seasonId: 1,
        });
        expect(data[0].players).toHaveLength(2);
        expect(data[0].players[0].points.gain).toBeGreaterThan(0);
    });

    test("matches can be filtered by player", async () => {
        const { config, deps, ladder, sessions } = setup();
        scoreMatches(ladder, 2);
        const token = await adminToken(sessions, "root");
        const res = await get(config, deps, "/admin/matches?limit=50&player=p0", token);
        const data: any = await res.json();
        expect(data).toHaveLength(10);
        expect(data.every((m: any) => m.players.some((p: any) => p.name === "p0"))).toBe(true);
    });

    test("player search finds prefix matches with standings", async () => {
        const { config, deps, ladder, sessions } = setup();
        scoreMatches(ladder, 2);
        const token = await adminToken(sessions, "root");
        const res = await get(config, deps, "/admin/players?q=p", token);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.map((p: any) => p.name)).toEqual(["p0", "p1"]);
        expect(data[0].standings[0]).toMatchObject({ ladderType: "1v1", wins: 10 });
        expect((await get(config, deps, "/admin/players", token)).status).toBe(400);
    });

    test("player history returns match list and 404s for unknown players", async () => {
        const { config, deps, ladder, sessions } = setup();
        scoreMatches(ladder, 1);
        const token = await adminToken(sessions, "root");
        const res = await get(config, deps, "/admin/players/p0?season=current&ladderType=1v1", token);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.name).toBe("p0");
        expect(data.matches).toHaveLength(10);
        expect(data.matches[0]).toMatchObject({ resultType: 0, mapName: "Island War" });
        expect((await get(config, deps, "/admin/players/nobody", token)).status).toBe(404);
    });

    test("public replay endpoint serves the .rpl without auth (deeplink)", async () => {
        const { config, deps, ladder } = setup();
        const replaysDir = (config as any).replaysDir = "/tmp/admin-replays-test";
        mkdirSync(replaysDir, { recursive: true });
        const replayContent = "RA2TSREPL_v6\nENGINE 0.83 0\ng1-pub 1723000000 opts\nEND 0\n";
        writeFileSync(path.join(replaysDir, "game-g1-pub 2026-08-16T00:00:00Z.rpl"), replayContent);
        ladder.archivePublicMatch({ gameId: "g1-pub", reportedAt: 1723000000000, players: ["alice", "bob"], replayPath: "game-g1-pub 2026-08-16T00:00:00Z.rpl" });

        // No Authorization header at all — public by design.
        const res = await handleHttp(new Request("http://localhost/replays/g1-pub"), deps, config);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("text/plain");
        expect(await res.text()).toBe(replayContent);

        expect((await handleHttp(new Request("http://localhost/replays/nope"), deps, config)).status).toBe(404);
    });

    test("replay folder scan lists files and backfill links unlinked ones", async () => {
        const { config, deps, sessions } = setup();
        const replaysDir = (config as any).replaysDir = `/tmp/admin-replays-folder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        mkdirSync(replaysDir, { recursive: true });
        // One file already archived, one orphan on disk.
        writeFileSync(path.join(replaysDir, "game-g1-test 2026-08-16T00:00:00Z.rpl"), "RA2TSREPL_v6\nEND 0\n");
        writeFileSync(path.join(replaysDir, "game-g2-orphan 2026-08-16T01:00:00Z.rpl"), "RA2TSREPL_v6\nEND 0\n");
        deps.ladder.archivePublicMatch({ gameId: "g1-test", reportedAt: 1723000000000, players: ["alice"], replayPath: "game-g1-test 2026-08-16T00:00:00Z.rpl" });
        const token = await adminToken(sessions, "root");

        const scan = await get(config, deps, "/admin/replay-files", token);
        expect(scan.status).toBe(200);
        const files: any = await scan.json();
        expect(files).toHaveLength(2);
        const orphan = files.find((f: any) => f.gameId === "g2-orphan");
        expect(orphan.inDb).toBe(false);
        expect(files.find((f: any) => f.gameId === "g1-test").inDb).toBe(true);

        const backfill = await post(config, deps, "/admin/replay-files/backfill", token);
        expect(backfill.status).toBe(200);
        expect((await backfill.json() as any).linked).toBe(1);

        const scan2 = await get(config, deps, "/admin/replay-files", token);
        const files2: any = await scan2.json();
        expect(files2.every((f: any) => f.inDb)).toBe(true);
    });

    test("admin config advertises the client and API origins", async () => {
        const { config, deps, sessions } = setup();
        (config as any).clientUrl = "https://play.thaira2.com";
        const token = await adminToken(sessions, "root");
        const res = await get(config, deps, "/admin/config", token);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            clientUrl: "https://play.thaira2.com",
            apiUrl: "http://127.0.0.1:9090",
        });
        // Requires admin like everything else.
        expect((await handleHttp(new Request("http://localhost/admin/config"), deps, config)).status).toBe(401);
    });

    test("admin routes answer preflight with CORS headers", async () => {
        const { config, deps } = setup();
        const res = await handleHttp(
            new Request("http://localhost/admin/seasons", {
                method: "OPTIONS",
                headers: { Origin: "http://localhost:5174" },
            }),
            deps,
            config,
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5174");
    });

    test("replays lists archived matches and downloads the .rpl file", async () => {
        const { config, deps, ladder, sessions } = setup();
        const replaysDir = (config as any).replaysDir = "/tmp/admin-replays-test";
        mkdirSync(replaysDir, { recursive: true });
        writeFileSync(path.join(replaysDir, "game-g1-test 2026-08-16T00:00:00Z.rpl"), "RA2TSREPL_v1\nEND 0\n");

        // Public match archived at game end; then the ranked report upgrades it.
        ladder.archivePublicMatch({ gameId: "g1-test", reportedAt: 1723000000000, players: ["alice", "bob"], replayPath: "game-g1-test 2026-08-16T00:00:00Z.rpl" });
        const token = await adminToken(sessions, "root");

        const list = await get(config, deps, "/admin/replays", token);
        expect(list.status).toBe(200);
        const entries: any = await list.json();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            gameId: "g1-test",
            ladderType: "",
            scored: false,
            replayFile: "game-g1-test 2026-08-16T00:00:00Z.rpl",
            players: [{ name: "alice", resultType: -1 }, { name: "bob", resultType: -1 }],
        });
        expect(entries[0].sizeBytes).toBeGreaterThan(0);

        const download = await get(config, deps, "/admin/replays/g1-test", token);
        expect(download.status).toBe(200);
        expect(download.headers.get("Content-Disposition")).toContain("attachment");
        expect(await download.text()).toContain("RA2TSREPL_v1");

        expect((await get(config, deps, "/admin/replays/nope", token)).status).toBe(404);
    });

    test("a public match upgraded by the ranked report keeps its replay path", async () => {
        const { config, deps, ladder, sessions } = setup();
        ladder.archivePublicMatch({ gameId: "g-upgrade", reportedAt: 1723000000000, players: ["alice", "bob"], replayPath: "game-g-upgrade 2026-08-16T00:00:00Z.rpl" });
        const scored = ladder.recordMatch({
            sku: RA2_SKU,
            gameId: "g-upgrade",
            ladderType: "1v1",
            duration: 300,
            mapName: "Island War",
            players: [
                { name: "alice", resultType: WolGameReportResult.Win },
                { name: "bob", resultType: WolGameReportResult.Loss },
            ],
        });
        expect(scored.players[0].mmr.gain).toBeGreaterThan(0);
        const match = deps.ladder.getMatch("g-upgrade")!;
        expect(match.scored).toBe(true);
        expect(match.ladderType).toBe("1v1");
        expect(match.replayPath).toBe("game-g-upgrade 2026-08-16T00:00:00Z.rpl");

        // A second report is the dedupe (still scored once).
        const again = ladder.recordMatch({
            sku: RA2_SKU,
            gameId: "g-upgrade",
            ladderType: "1v1",
            duration: 300,
            players: [
                { name: "alice", resultType: WolGameReportResult.Win },
                { name: "bob", resultType: WolGameReportResult.Loss },
            ],
        });
        expect(again).toEqual(scored);
        const profile = deps.ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"]);
        expect(profile![0].placementMatchesLeft).toBe(9);
    });
});
