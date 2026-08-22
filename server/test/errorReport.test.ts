import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 7z-wasm's own .d.ts is inaccurate on two points real usage relies on
// (callMain actually returns the process exit code, not void; wasmBinary
// accepts any ArrayBufferView, not just a plain ArrayBuffer) -- same `any`
// escape hatch server/src/diagnostics/errorReportArchive.ts and
// src/worker/workerApi.ts already use for this library.
const SevenZip = (await import("7z-wasm")).default as any;
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

function setup(errorReportsDir: string, desyncTimeoutMillis = 30, replaySnapshot?: HttpDeps["replaySnapshot"]) {
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
    const deps: HttpDeps = { accounts, sessions, ladder, gservs, wol, replaySnapshot };
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

// Mirrors src/worker/workerApi.ts's compressFiles() -- builds the same
// "single 7z archive containing report.json (+ optional extra entries)"
// wire format the real client now uploads, so these tests exercise the
// actual server-side extraction path (errorReportArchive.ts) rather than
// bypassing it.
let wasmBinaryPromise: Promise<Buffer> | undefined;
function loadWasmBinary(): Promise<Buffer> {
    wasmBinaryPromise ??= (async () => {
        const wasmPath = fileURLToPath(import.meta.resolve("7z-wasm/7zz.wasm"));
        return readFileSync(wasmPath);
    })();
    return wasmBinaryPromise;
}

async function makeArchive(files: { name: string; data: Uint8Array | string }[]): Promise<Uint8Array> {
    const wasmBinary = await loadWasmBinary();
    const sevenZip = await SevenZip({ wasmBinary, stderr: () => {} });
    // Entry names inside the archive must be exact (no prefix): the server
    // extracts "report.json" by that literal name.
    const inputPaths = files.map((file) => {
        const inputPath = "/" + file.name;
        sevenZip.FS.writeFile(inputPath, file.data);
        return inputPath;
    });
    const exitCode = sevenZip.callMain(["a", "-t7z", "-mx=1", "/__archive_output.7z", ...inputPaths]);
    if (exitCode !== 0) {
        throw new Error(`test helper: 7z compression failed with exit code ${exitCode}`);
    }
    return new Uint8Array(sevenZip.FS.readFile("/__archive_output.7z"));
}

async function extractOneFile(archiveBytes: Uint8Array, fileName: string): Promise<string> {
    const wasmBinary = await loadWasmBinary();
    const bytes: number[] = [];
    const sevenZip = await SevenZip({
        wasmBinary,
        stdout: (charCode: number | null) => { if (charCode !== null) bytes.push(charCode); },
        stderr: () => {},
    });
    sevenZip.FS.writeFile("/incoming.7z", archiveBytes);
    sevenZip.callMain(["x", "/incoming.7z", "-so", fileName]);
    return new TextDecoder().decode(new Uint8Array(bytes));
}

async function post(deps: HttpDeps, config: ServerConfig, reportBody: unknown, extraFiles: { name: string; data: Uint8Array | string }[] = []): Promise<Response> {
    const archiveBytes = await makeArchive([
        { name: "report.json", data: JSON.stringify(reportBody) },
        ...extraFiles,
    ]);
    return handleHttp(
        new Request("http://localhost/errorreport/16640", {
            method: "POST",
            body: archiveBytes,
            headers: { "content-type": "application/x-7z-compressed" },
        }),
        deps,
        config,
        makeTestLogger(),
    );
}

function readReportFiles(dir: string, gameId: string): any[] {
    const gameDir = path.join(dir, gameId);
    return readdirSync(gameDir)
        .filter(name => name.endsWith(".json"))
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

    test("rejects a malformed report.json", async () => {
        const dir = __dirname + "/tmp-error-reports-invalid";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir);

        const res = await post(deps, config, { gameId: "g1", errorType: "not_a_real_type" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).errorCode).toBe("invalid_report");
    });

    test("rejects a request body that isn't a valid 7z archive", async () => {
        const dir = __dirname + "/tmp-error-reports-notarchive";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir);

        const res = await handleHttp(
            new Request("http://localhost/errorreport/16640", {
                method: "POST",
                body: new TextEncoder().encode(JSON.stringify(baseReport())),
                headers: { "content-type": "application/x-7z-compressed" },
            }),
            deps,
            config,
            makeTestLogger(),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).errorCode).toBe("invalid_request");
    });

    test("the whole uploaded archive is persisted as a single .7z file, containing report.json and any extra entries", async () => {
        const dir = __dirname + "/tmp-error-reports-bundle";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir, 5000);

        const res = await post(deps, config, baseReport({
            gameId: "g-bundle",
            errorType: "game_crash",
            nick: "charge",
        }), [
            { name: "desync-debug.json", data: JSON.stringify({ stateDump: [1, 2, 3], lockstepLog: "line1\nline2" }) },
        ]);
        expect(res.status).toBe(200);

        const gameDir = path.join(dir, "g-bundle");
        const entries = readdirSync(gameDir).sort();
        expect(entries.length).toBe(2);
        const jsonName = entries.find(name => name.endsWith(".json"))!;
        const archiveName = entries.find(name => name.endsWith(".7z"))!;
        expect(jsonName).toBeDefined();
        expect(archiveName).toBeDefined();

        const persisted = JSON.parse(readFileSync(path.join(gameDir, jsonName), "utf8"));
        expect(persisted.report.archiveFile).toBe(archiveName);

        const archiveBytes = new Uint8Array(readFileSync(path.join(gameDir, archiveName)));
        const reportJson = JSON.parse(await extractOneFile(archiveBytes, "report.json"));
        expect(reportJson.gameId).toBe("g-bundle");
        const debugJson = JSON.parse(await extractOneFile(archiveBytes, "desync-debug.json"));
        expect(debugJson.stateDump).toEqual([1, 2, 3]);
        expect(debugJson.lockstepLog).toBe("line1\nline2");
    });

    test("a live in-progress replay snapshot is folded into the persisted archive as game.rpl", async () => {
        const dir = __dirname + "/tmp-error-reports-replay";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const replayText = "RA2TSREPL_v6\nENGINE 0.83 0\ng-replay 1700000000 \n30=0|abcd\nEND 30\n";
        const { config, deps } = setup(dir, 20, (gameId) => gameId === "g-replay" ? replayText : undefined);

        const res = await post(deps, config, baseReport({ gameId: "g-replay", errorType: "desync_error", nick: "charge" }));
        expect(res.status).toBe(200);
        await Bun.sleep(60);

        const gameDir = path.join(dir, "g-replay");
        const archiveName = readdirSync(gameDir).find(name => name.endsWith(".7z"))!;
        const archiveBytes = new Uint8Array(readFileSync(path.join(gameDir, archiveName)));
        expect(await extractOneFile(archiveBytes, "game.rpl")).toBe(replayText);
        // report.json must still be present and intact alongside it.
        const reportJson = JSON.parse(await extractOneFile(archiveBytes, "report.json"));
        expect(reportJson.gameId).toBe("g-replay");
    });

    test("no live instance for the gameId (replaySnapshot returns undefined) still persists the report, with no game.rpl entry", async () => {
        const dir = __dirname + "/tmp-error-reports-noreplay";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir, 5000, () => undefined);

        const res = await post(deps, config, baseReport({ gameId: "g-noreplay", errorType: "game_crash", nick: "charge" }));
        expect(res.status).toBe(200);

        const gameDir = path.join(dir, "g-noreplay");
        const archiveName = readdirSync(gameDir).find(name => name.endsWith(".7z"))!;
        const archiveBytes = new Uint8Array(readFileSync(path.join(gameDir, archiveName)));
        expect(await extractOneFile(archiveBytes, "game.rpl")).toBe("");
        const reportJson = JSON.parse(await extractOneFile(archiveBytes, "report.json"));
        expect(reportJson.gameId).toBe("g-noreplay");
    });

    test("a replaySnapshot lookup that throws doesn't prevent the report from being persisted", async () => {
        const dir = __dirname + "/tmp-error-reports-replaythrows";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir, 5000, () => {
            throw new Error("simulated live-instance lookup failure");
        });

        const res = await post(deps, config, baseReport({ gameId: "g-replaythrows", errorType: "game_crash", nick: "charge" }));
        expect(res.status).toBe(200);
        const files = readReportFiles(dir, "g-replaythrows");
        expect(files.length).toBe(1);
    });

    test("an oversized request body is rejected before extraction", async () => {
        const dir = __dirname + "/tmp-error-reports-bundle-toolarge";
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { config, deps } = setup(dir);

        // Random, not repeated, bytes: LZMA compresses a repeated-character
        // string down to almost nothing, which would defeat the point of
        // this test (asserting the byte-size guard fires on the actual
        // *uploaded* archive) -- incompressible data keeps the archive close
        // to its uncompressed size instead.
        const incompressible = new Uint8Array(randomBytes(5 * 1024 * 1024).buffer);
        const res = await post(deps, config, baseReport({ gameId: "g-toolarge", errorType: "game_crash" }), [
            { name: "desync-debug.json", data: incompressible },
        ]);
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

    test("validateErrorReport still rejects a malformed report object directly", () => {
        expect(() => validateErrorReport({ gameId: "g1", errorType: "not_a_real_type" }))
            .toThrow(ErrorReportValidationError);
    });
});
