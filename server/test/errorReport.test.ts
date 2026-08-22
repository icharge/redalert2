import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { handleHttp, HttpDeps } from "../src/http/routes";
import { validateErrorReport, ErrorReportValidationError } from "../src/diagnostics/errorReportCodec";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { loadConfig, ServerConfig } from "../src/config";
import { MemoryStorage } from "../src/storage/MemoryStorage";
import { LadderService } from "../src/ladder/LadderService";
import { GservManager } from "../src/gserv/GservManager";
import { WolServer } from "../src/server/WolServer";

function makeTestLogger() {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    } as any;
}

function setup(errorReportsDir: string, desyncTimeoutMillis = 30) {
    const config = loadConfig({
        ERROR_REPORTS_DIR: errorReportsDir,
        GSERV_DESYNC_REPORT_TIMEOUT_MILLIS: String(desyncTimeoutMillis),
        GSERV_ERROR_REPORT_MAX_PER_MIN: "1000",
    });
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
    return { config, deps };
}

function baseReport(overrides: Record<string, unknown> = {}) {
    return {
        gameId: "g1-test",
        nick: "charge",
        errorType: "desync_error",
        message: "Desync detected",
        timestamp: Date.now(),
        clientVersion: "0.83.4",
        ...overrides,
    };
}

function hashBreakdown(overrides: Record<string, number> = {}) {
    return {
        currentTick: 1440,
        lastRandom: 111,
        nextObjectId: 500,
        objectCount: 42,
        objectsHash: 777,
        playersHash: 222,
        creditsSum: 9000,
        alliancesHash: 1,
        gameTraitsHash: 5,
        ...overrides,
    };
}

async function post(deps: HttpDeps, config: ServerConfig, body: unknown): Promise<Response> {
    return handleHttp(
        new Request("http://localhost/errorreport/16640", {
            method: "POST",
            body: JSON.stringify(body),
        }),
        deps,
        config,
        makeTestLogger(),
    );
}

function readReportFiles(dir: string, gameId: string): any[] {
    const gameDir = path.join(dir, gameId);
    return readdirSync(gameDir)
        .sort()
        .map(name => JSON.parse(readFileSync(path.join(gameDir, name), "utf8")));
}

describe("POST /errorreport", () => {
    test("two desync reports for the same gameId are diffed and both persisted", async () => {
        const dir = __dirname + "/tmp-error-reports";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir);

        const resA = await post(deps, config, baseReport({
            nick: "charge",
            gameState: {
                tick: 1440,
                hashBreakdown: hashBreakdown({ objectsHash: 111 }),
                objectHashes: [
                    { id: 1, name: "E1", hash: 10 },
                    { id: 2, name: "3TNK", hash: 20 },
                ],
            },
        }));
        expect(resA.status).toBe(200);
        expect(((await resA.json()) as any).accepted).toBe(true);

        const resB = await post(deps, config, baseReport({
            nick: "bob",
            gameState: {
                tick: 1440,
                hashBreakdown: hashBreakdown({ objectsHash: 222 }),
                objectHashes: [
                    { id: 1, name: "E1", hash: 10 },
                    { id: 2, name: "3TNK", hash: 99 },
                ],
            },
        }));
        expect(resB.status).toBe(200);

        const files = readReportFiles(dir, "g1-test");
        expect(files.length).toBe(2);
        for (const file of files) {
            expect(file.diff.hashBreakdownMismatches).toContain("objectsHash");
            expect(file.diff.objectMismatches).toEqual([
                { id: 2, name: "3TNK", reason: "value_mismatch", hashA: 20, hashB: 99 },
            ]);
        }
    });

    test("a single desync report with no peer still resolves and persists after the correlation window", async () => {
        const dir = __dirname + "/tmp-error-reports-solo";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir, 20);

        const res = await post(deps, config, baseReport({ gameId: "g-solo", nick: "charge" }));
        expect(res.status).toBe(200);

        // Nothing persisted yet -- still inside the correlation window.
        expect(() => readReportFiles(dir, "g-solo")).toThrow();

        await Bun.sleep(60);

        const files = readReportFiles(dir, "g-solo");
        expect(files.length).toBe(1);
        expect(files[0].diff).toBeUndefined();
        expect(files[0].report.nick).toBe("charge");
    });

    test("non-desync errorTypes persist immediately without waiting", async () => {
        const dir = __dirname + "/tmp-error-reports-crash";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir, 5000);

        const res = await post(deps, config, baseReport({ gameId: "g-crash", errorType: "game_crash", nick: "charge" }));
        expect(res.status).toBe(200);

        const files = readReportFiles(dir, "g-crash");
        expect(files.length).toBe(1);
        expect(files[0].report.errorType).toBe("game_crash");
    });

    test("rejects a malformed report", async () => {
        const dir = __dirname + "/tmp-error-reports-invalid";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir);

        const res = await post(deps, config, { gameId: "g1", errorType: "not_a_real_type" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).errorCode).toBe("invalid_report");
    });

    test("a desync report with a debugBundle is persisted as a sibling .7z file, not inlined in the JSON", async () => {
        const dir = __dirname + "/tmp-error-reports-bundle";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir, 5000);

        const bundleBytes = Buffer.from("not-really-a-7z-but-bytes-are-bytes");
        const res = await post(deps, config, baseReport({
            gameId: "g-bundle",
            errorType: "game_crash",
            nick: "charge",
            debugBundle: bundleBytes.toString("base64"),
        }));
        expect(res.status).toBe(200);

        const gameDir = path.join(dir, "g-bundle");
        const entries = readdirSync(gameDir).sort();
        expect(entries.length).toBe(2);
        const jsonName = entries.find(name => name.endsWith(".json"))!;
        const bundleName = entries.find(name => name.endsWith(".debug.7z"))!;
        expect(jsonName).toBeDefined();
        expect(bundleName).toBeDefined();

        const persisted = JSON.parse(readFileSync(path.join(gameDir, jsonName), "utf8"));
        expect(persisted.report.debugBundle).toBeUndefined();
        expect(persisted.report.debugBundleFile).toBe(bundleName);

        const decodedBundle = readFileSync(path.join(gameDir, bundleName));
        expect(decodedBundle.equals(bundleBytes)).toBe(true);
    });

    test("validateErrorReport rejects a debugBundle past MAX_DEBUG_BUNDLE_BASE64_LENGTH", () => {
        // Exercised directly against the codec, not through handleHttp: at
        // this size the outer per-request body-size guard in routes.ts
        // (config.maxErrorReportBytes, default 4 MiB) would reject the
        // request before validateErrorReport's own field-length check ever
        // runs -- that guard is covered separately below.
        expect(() => validateErrorReport(baseReport({
            debugBundle: "A".repeat(8 * 1024 * 1024 + 1),
        }))).toThrow(ErrorReportValidationError);
    });

    test("an oversized request body (debugBundle included) is rejected before parsing", async () => {
        const dir = __dirname + "/tmp-error-reports-bundle-toolarge";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir);

        const res = await post(deps, config, baseReport({
            gameId: "g-toolarge",
            errorType: "game_crash",
            debugBundle: "A".repeat(5 * 1024 * 1024),
        }));
        expect(res.status).toBe(413);
    });

    test("without a bearer token the report is accepted but unauthenticated, using the self-reported nick", async () => {
        const dir = __dirname + "/tmp-error-reports-anon";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir, 5000);

        const res = await post(deps, config, baseReport({ gameId: "g-anon", errorType: "game_crash", nick: "totally-unverified" }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).authenticated).toBe(false);

        const files = readReportFiles(dir, "g-anon");
        expect(files[0].report.nick).toBe("totally-unverified");
    });
});
