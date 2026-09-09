import { describe, expect, test } from "bun:test";
import { handleHttp, HttpDeps } from "../src/http/routes";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { loadConfig } from "../src/config";
import { makeTestStorage } from "./helpers";
import { LadderService } from "../src/ladder/LadderService";
import { GservManager } from "../src/gserv/GservManager";
import { WolServer } from "../src/server/WolServer";
import { MapStore } from "../src/mapstore/MapStore";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

const SAMPLE_MAP = `[Map]
Size=32,32,64,64
[Basic]
Name=Route Battleground
Official=no
GameMode=MeatGrinder
[Waypoints]
0=10,10
1=20,20
[Terrain]
0,0=Dirt
`;

function make(extraEnv: Record<string, string> = {}) {
    const config = loadConfig({ ...extraEnv, MAP_SERVICE: "enabled" });
    const storage = makeTestStorage();
    const accounts = new AccountStore(storage, config);
    const sessions = new SessionManager(storage, config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const wol = new WolServer(config, sessions, accounts, gservs);
    const ladder = new LadderService(storage, makeTestLogger(), {
        startingRating: config.startingRating,
        placementMatches: config.placementMatches,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "ra2-maproutes-"));
    const maps = new MapStore(new Database(":memory:"), { mapsDir: dir, maxUploadBytes: 1024 * 1024 });
    const deps: HttpDeps = { accounts, sessions, ladder, gservs, wol, maps };
    return { config, accounts, sessions, deps, maps, dir };
}

function makeTestLogger() {
    return { level: "error" as const, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
}

async function uploadMap(deps: HttpDeps, config: any, token: string, name = "route.map", bytes = new TextEncoder().encode(SAMPLE_MAP)) {
    return handleHttp(new Request(`http://localhost/maps/upload?name=${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: bytes,
    }), deps, config);
}

describe("map routes", () => {
    test("upload requires auth", async () => {
        const { config, deps } = make();
        const res = await uploadMap(deps, config, "");
        expect(res.status).toBe(401);
    });

    test("upload, list, download and dedup round-trip", async () => {
        const { config, deps } = make();
        const token = deps.sessions.create("alice");

        const up = await uploadMap(deps, config, token);
        expect(up.status).toBe(200);
        const uploaded: any = await up.json();
        expect(uploaded.filename).toBe("route.map");
        expect(uploaded.title).toBe("Route Battleground");
        expect(uploaded.maxPlayers).toBe(2);
        expect(uploaded.deduplicated).toBe(false);
        const sha = uploaded.sha256 as string;

        const dup = await uploadMap(deps, config, token);
        const duplicated: any = await dup.json();
        expect(duplicated.sha256).toBe(sha);
        expect(duplicated.deduplicated).toBe(true);
        expect(duplicated.uploads).toBe(2);

        const list = await handleHttp(new Request("http://localhost/maps"), deps, config);
        expect(list.status).toBe(200);
        const listBody: any = await list.json();
        expect(listBody.total).toBe(1);
        expect(listBody.items[0].stats.plays).toBe(0);
        expect(listBody.items[0].filename).toBe("route.map");

        const download = await handleHttp(new Request(`http://localhost/maps/${sha}`), deps, config);
        expect(download.status).toBe(200);
        const downloaded = new Uint8Array(await download.arrayBuffer());
        expect(downloaded.length).toBe(SAMPLE_MAP.length);

        const byName = await handleHttp(new Request("http://localhost/maps/route.map"), deps, config);
        expect(byName.status).toBe(200);

        const missing = await handleHttp(new Request("http://localhost/maps/nope.map"), deps, config);
        expect(missing.status).toBe(404);
    });

    test("live maps.pkt renders visible maps with client-compatible fields", async () => {
        const { config, deps } = make();
        const token = deps.sessions.create("alice");
        await uploadMap(deps, config, token, "route.map");

        const res = await handleHttp(new Request("http://localhost/maps.pkt"), deps, config);
        expect(res.status).toBe(200);
        const pkt = await res.text();
        expect(pkt).toContain("[MultiMaps]");
        expect(pkt).toContain("1=route");
        expect(pkt).toContain("File=route.map");
        expect(pkt).toContain("Description=Route Battleground");
        expect(pkt).toContain("MaxPlayers=2");
        expect(pkt).toContain("GameMode=MeatGrinder");
    });

    test("hidden maps are excluded from the public list and pkt", async () => {
        const { config, deps } = make();
        const token = deps.sessions.create("alice");
        await uploadMap(deps, config, token, "hidden.map");

        const list: any = await (await handleHttp(new Request("http://localhost/maps"), deps, config)).json();
        expect(list.total).toBe(1);
        const pkt = await (await handleHttp(new Request("http://localhost/maps.pkt"), deps, config)).text();
        expect(pkt).toContain("hidden.map");

        // Moderate it away.
        const adminToken = deps.sessions.create("boss");
        config.adminUsernames = ["boss"];
        const hide = await handleHttp(new Request(`http://localhost/admin/maps/${list.items[0].sha256}/visible?visible=0`, {
            method: "POST",
            headers: { authorization: `Bearer ${adminToken}` },
        }), deps, config);
        expect(hide.status).toBe(200);

        const list2: any = await (await handleHttp(new Request("http://localhost/maps"), deps, config)).json();
        expect(list2.total).toBe(0);
        const pkt2 = await (await handleHttp(new Request("http://localhost/maps.pkt"), deps, config)).text();
        expect(pkt2).not.toContain("hidden.map");
        const direct = await handleHttp(new Request("http://localhost/maps/hidden.map"), deps, config);
        expect(direct.status).toBe(404);

        const adminList: any = await (await handleHttp(new Request("http://localhost/admin/maps", {
            headers: { authorization: `Bearer ${adminToken}` },
        }), deps, config)).json();
        expect(adminList.total).toBe(1);
    });

    test("rating requires auth and updates stats", async () => {
        const { config, deps } = make();
        const token = deps.sessions.create("alice");
        const uploaded: any = await (await uploadMap(deps, config, token)).json();

        const noAuth = await handleHttp(new Request(`http://localhost/maps/${uploaded.sha256}/rate`, {
            method: "POST",
            body: JSON.stringify({ stars: 5 }),
        }), deps, config);
        expect(noAuth.status).toBe(401);

        const rate = await handleHttp(new Request(`http://localhost/maps/${uploaded.sha256}/rate`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ stars: 5 }),
        }), deps, config);
        expect(rate.status).toBe(200);
        const rated: any = await rate.json();
        expect(rated.ratingAvg).toBe(5);
        expect(rated.ratingCount).toBe(1);

        const meta: any = await (await handleHttp(new Request(`http://localhost/maps/${uploaded.sha256}/meta`, {
            headers: { authorization: `Bearer ${token}` },
        }), deps, config)).json();
        expect(meta.userRating).toBe(5);
        expect(meta.uploadLog[0].username).toBe("alice");
    });

    test("maptransfer PUT/GET works like the legacy game-time flow", async () => {
        const { config, deps } = make();
        const host = deps.sessions.create("host");
        const guest = deps.sessions.create("guest");
        const gameId = "game-abc123";

        const put = await handleHttp(new Request(`http://localhost/maptransfer/${gameId}`, {
            method: "PUT",
            headers: { authorization: `Bearer ${host}`, "Content-Type": "application/octet-stream" },
            body: new TextEncoder().encode(SAMPLE_MAP),
        }), deps, config);
        expect(put.status).toBe(200);

        const get = await handleHttp(new Request(`http://localhost/maptransfer/${gameId}`, {
            headers: { authorization: `Bearer ${guest}` },
        }), deps, config);
        expect(get.status).toBe(200);
        const bytes = new Uint8Array(await get.arrayBuffer());
        expect(bytes.length).toBe(SAMPLE_MAP.length);

        const unauthorized = await handleHttp(new Request(`http://localhost/maptransfer/${gameId}`), deps, config);
        expect(unauthorized.status).toBe(401);
        const unknown = await handleHttp(new Request("http://localhost/maptransfer/no-such-game", {
            headers: { authorization: `Bearer ${guest}` },
        }), deps, config);
        expect(unknown.status).toBe(404);
    });

    test("maps namespaces 404 when the feature is disabled", async () => {
        const config = loadConfig({ MAP_SERVICE: "disabled" });
        const storage = makeTestStorage();
        const accounts = new AccountStore(storage, config);
        const sessions = new SessionManager(storage, config.sessionTtlSeconds);
        const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
        const wol = new WolServer(config, sessions, accounts, gservs);
        const ladder = new LadderService(storage, makeTestLogger(), {
            startingRating: config.startingRating,
            placementMatches: config.placementMatches,
        });
        const deps: HttpDeps = { accounts, sessions, ladder, gservs, wol };
        const res = await handleHttp(new Request("http://localhost/maps"), deps, config);
        expect(res.status).toBe(404);
        const pkt = await handleHttp(new Request("http://localhost/maps.pkt"), deps, config);
        expect(pkt.status).toBe(404);
        const transfer = await handleHttp(new Request("http://localhost/maptransfer/x", { method: "PUT" }), deps, config);
        expect(transfer.status).toBe(404);
    });

    test("servers.ini advertises mapTransferUrl when enabled", async () => {
        const { config, deps } = make();
        const res = await handleHttp(new Request("http://localhost/servers.ini"), deps, config);
        const ini = await res.text();
        expect(ini).toMatch(/mapTransferUrl=".*\/maptransfer"/);
    });
});
