/**
 * Gserv turn-relay performance benchmark (end to end).
 *
 * Boots the real gserv server with the same wiring as src/index.ts, connects
 * N real WebSocket clients through the full ticket -> join -> loaded flow,
 * then measures the two things that matter for in-game ticking:
 *
 *   1. Throughput: turns/sec the relay sustains when turns are pushed
 *      back-to-back (pipelined) from every player.
 *   2. Latency: time from the last player's action frame reaching the server
 *      until every player has received the turn broadcast.
 *
 * The per-connection flood limiter is intentionally disabled
 * (GSERV_RATE_LIMIT=disabled): a throughput benchmark is a flood by
 * construction, and the 600-token bucket exists to kill exactly that. Real
 * gameplay at the 33ms net rate (~30 turns/s) never gets near it. Replay
 * recording stays ON because the recorder re-parses and re-encodes every turn
 * and is part of the production hot path.
 *
 * Usage:
 *   bun run scripts/gserv-tick-perf.ts
 *   PLAYERS=16 PAYLOAD=128 TURNS=5000 bun run scripts/gserv-tick-perf.ts
 *   MIN_TURNS_PER_SEC=100 bun run scripts/gserv-tick-perf.ts
 */
import path from "node:path";
import os from "node:os";
import { GservServer } from "../src/gserv/GservServer";
import { GservManager } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { serializePlayerActions } from "../src/gserv/replay/gameoptCodec";

const PLAYERS = (process.env.PLAYERS ?? "2,4,8").split(",").map(Number).filter(Boolean);
const PAYLOADS = (process.env.PAYLOAD ?? "64,512").split(",").map(Number).filter(Boolean);
const WARMUP_TURNS = Number(process.env.WARMUP_TURNS ?? 200);
const MEASURED_TURNS = Number(process.env.TURNS ?? 2000);
const LATENCY_TURNS = Number(process.env.LATENCY_TURNS ?? 200);
const MIN_TURNS_PER_SEC = Number(process.env.MIN_TURNS_PER_SEC ?? 200);

const config = loadConfig({
    GSERV_RATE_LIMIT: "disabled",
    LOG_LEVEL: (process.env.LOG_LEVEL as never) ?? "warn",
    GSERV_STATS_INTERVAL_SECONDS: process.env.GSERV_STATS_INTERVAL_SECONDS,
    LOG_FILE: "",
    RECORD_REPLAYS: "true",
    REPLAYS_DIR: path.join(os.tmpdir(), "ra2web-perf-replays"),
});

const manager = new GservManager({ id: "gs1", url: "ws://127.0.0.1/gserv" });
const gserv = new GservServer(config, manager);

const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response("Not found", { status: 404 });
        }
        const upgraded = srv.upgrade(req, { data: { target: "gserv" } });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
        maxPayloadLength: config.maxPayloadBytes,
        open(ws) {
            ws.data.client = gserv.handleOpen(ws);
        },
        message(ws, message) {
            if (ws.data.client) {
                gserv.handleMessage(ws.data.client, message);
            }
        },
        close(ws) {
            if (ws.data.client) {
                gserv.handleClose(ws.data.client);
            }
        },
    },
});
const gservUrl = `ws://127.0.0.1:${server.port}${config.gservUrlPath}`;
gserv.startSweepLoop();

function buildGameOpts(names: string[]): string {
    const optionsPart = "0,0,0,10000,50,0,0,0,1,0,0,0,SXNsYW5kIFdhcg==,8,1,100,mpdefault,abc,1,0,0,1,0";
    const playersPart = names.map((name, i) => `${name},1,${i + 1},${i + 1},1,0,0,0`).join(",");
    return `${optionsPart}:${playersPart}:@:,-1,-1,-1,-1,`;
}

function turnNoOf(frame: Uint8Array): number {
    return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, true);
}

function makeRequestFrame(turnNo: number, blob: Uint8Array): Uint8Array {
    const frame = new Uint8Array(6 + blob.length);
    frame[0] = 2; // REQ_BIN_PREFIX
    frame[1] = 1; // REQ_BIN_GAME_ACTIONS
    new DataView(frame.buffer).setUint32(2, turnNo, true);
    frame.set(blob, 6);
    return frame;
}

function makeActionBlob(size: number): Uint8Array {
    return serializePlayerActions([{ id: 1, params: new Uint8Array(Math.max(0, size - 2)) }]);
}

interface TurnWaiter {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

class BenchClient {
    readonly ws: WebSocket;
    received = 0;
    lastTurnNo = -1;
    private frames: Uint8Array[] = [];
    private lines: string[] = [];
    private turnWaiters = new Map<number, TurnWaiter>();
    private lineWaiters: Array<{
        predicate: (line: string) => boolean;
        resolve: (line: string) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];
    private readonly openPromise: Promise<void>;

    constructor(url: string) {
        this.ws = new WebSocket(url);
        this.ws.binaryType = "arraybuffer";
        this.ws.addEventListener("message", event => this.handleMessage(event.data));
        this.openPromise = new Promise((resolve, reject) => {
            this.ws.addEventListener("open", () => resolve());
            this.ws.addEventListener("error", () => reject(new Error("gserv websocket error")));
        });
    }

    get open(): Promise<void> {
        return this.openPromise;
    }

    send(data: string | Uint8Array): void {
        this.ws.send(typeof data === "string" ? data + "\r\n" : data);
    }

    close(): void {
        this.ws.close();
    }

    waitForLine(predicate: (line: string) => boolean, name: string): Promise<string> {
        const index = this.lines.findIndex(predicate);
        if (index !== -1) {
            return Promise.resolve(this.lines.splice(index, 1)[0]);
        }
        return new Promise<string>((resolve, reject) => {
            const w = {
                predicate,
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.lineWaiters.splice(this.lineWaiters.indexOf(w), 1);
                    reject(new Error(`timeout waiting for gserv "${name}"`));
                }, 10_000),
            };
            this.lineWaiters.push(w);
        });
    }

    waitForTurn(turnNo: number): Promise<void> {
        const index = this.frames.findIndex(frame => turnNoOf(frame) === turnNo);
        if (index !== -1) {
            this.frames.splice(index, 1);
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const w: TurnWaiter = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.turnWaiters.delete(turnNo);
                    reject(new Error(`timeout waiting for gserv turn ${turnNo}`));
                }, 10_000),
            };
            this.turnWaiters.set(turnNo, w);
        });
    }

    private handleMessage(data: unknown): void {
        if (typeof data === "string") {
            for (const w of [...this.lineWaiters]) {
                if (w.predicate(data)) {
                    clearTimeout(w.timer);
                    this.lineWaiters.splice(this.lineWaiters.indexOf(w), 1);
                    w.resolve(data);
                    return;
                }
            }
            this.lines.push(data);
            return;
        }
        const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
        const turnNo = turnNoOf(frame);
        this.received += 1;
        this.lastTurnNo = Math.max(this.lastTurnNo, turnNo);
        const waiter = this.turnWaiters.get(turnNo);
        if (waiter) {
            clearTimeout(waiter.timer);
            this.turnWaiters.delete(turnNo);
            waiter.resolve();
            return;
        }
        this.frames.push(frame);
    }
}

interface ScenarioResult {
    playerCount: number;
    payloadBytes: number;
    turnsPerSec: number;
    relayedMbPerSec: number;
    latencies: number[];
}

async function joinGame(playerCount: number, manager: GservManager): Promise<{ instance: ReturnType<GservManager["create"]>; clients: BenchClient[] }> {
    const nicks = Array.from({ length: playerCount }, (_, i) => `p${i}`);
    const instance = manager.create(nicks, gservUrl);
    instance.gameopts = buildGameOpts(nicks);
    const clients: BenchClient[] = [];
    for (const nick of nicks) {
        const client = new BenchClient(gservUrl);
        await client.open;
        clients.push(client);
        const ticket = instance.tickets.get(nick)!;
        client.send(`ticket ${ticket}`);
        await client.waitForLine(line => line.includes(" 100 "), "ticket login");
        client.send(`join ${instance.gameId} 0.83 `);
        await client.waitForLine(line => line.includes(" 400 "), "join instance");
        client.send("loaded 100");
    }
    // The game starts only once every roster player has joined and loaded, so
    // wait for RPL_NET_RATE on all clients after the roster is complete.
    await Promise.all(clients.map(client => client.waitForLine(line => line.includes(" 802 "), "net rate")));
    return { instance, clients };
}

function percentile(sorted: number[], p: number): number {
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
}

async function runScenario(playerCount: number, targetPayload: number): Promise<ScenarioResult> {
    const blob = makeActionBlob(targetPayload);
    const { clients } = await joinGame(playerCount, manager);

    // Real clients only send turn t+1 after receiving turn t's broadcast, so
    // pump turns in the same feedback loop. Bulk-sending thousands of turns at
    // once would let one connection outrun the others, tripping the server's
    // 8-turn window (which exists to drop turns from lagging players in real
    // play) and measuring nothing useful.
    const pump = async (startTurnNo: number, count: number): Promise<void> => {
        for (let turnNo = startTurnNo; turnNo < startTurnNo + count; turnNo++) {
            const frame = makeRequestFrame(turnNo, blob);
            for (const client of clients) {
                client.send(frame);
            }
            await Promise.all(clients.map(client => client.waitForTurn(turnNo)));
        }
    };

    const t0 = performance.now();
    await pump(0, WARMUP_TURNS + MEASURED_TURNS);
    const elapsedMs = performance.now() - t0;
    const turnsPerSec = MEASURED_TURNS / (elapsedMs / 1000);

    const latencies: number[] = [];
    const firstLatencyTurn = WARMUP_TURNS + MEASURED_TURNS;
    for (let i = 0; i < LATENCY_TURNS; i++) {
        const turnNo = firstLatencyTurn + i;
        for (const client of clients.slice(0, -1)) {
            client.send(makeRequestFrame(turnNo, blob));
        }
        const t0 = performance.now();
        clients[clients.length - 1].send(makeRequestFrame(turnNo, blob));
        await Promise.all(clients.map(client => client.waitForTurn(turnNo)));
        latencies.push(performance.now() - t0);
    }

    const expectedFrames = WARMUP_TURNS + MEASURED_TURNS + LATENCY_TURNS;
    for (const client of clients) {
        if (client.received !== expectedFrames || client.lastTurnNo !== expectedFrames - 1) {
            throw new Error(
                `frame loss: client received ${client.received}/${expectedFrames} turns (last ${client.lastTurnNo})`,
            );
        }
        client.close();
    }

    return {
        playerCount,
        payloadBytes: blob.length,
        turnsPerSec,
        relayedMbPerSec: (turnsPerSec * playerCount * (6 + blob.length * playerCount)) / (1024 * 1024),
        latencies,
    };
}

async function main(): Promise<void> {
    console.log(
        `gserv tick benchmark: ${PLAYERS.join("/")} players, ${PAYLOADS.join("/")}B payloads, ` +
            `${MEASURED_TURNS} measured turns (+${WARMUP_TURNS} warmup), ${LATENCY_TURNS} latency turns`,
    );
    console.log(
        `rate limiter disabled (a benchmark is a flood; real play at ${config.netRateMs}ms net rate is ~${Math.round(1000 / config.netRateMs)} turns/s), replay recording on\n`,
    );

    let allPass = true;
    for (const playerCount of PLAYERS) {
        for (const payload of PAYLOADS) {
            const result = await runScenario(playerCount, payload);
            const sorted = [...result.latencies].sort((a, b) => a - b);
            const avg = sorted.length ? sorted.reduce((sum, v) => sum + v, 0) / sorted.length : 0;
            const p95 = sorted.length ? percentile(sorted, 95) : 0;
            const max = sorted.length ? sorted[sorted.length - 1] : 0;
            const pass = result.turnsPerSec >= MIN_TURNS_PER_SEC;
            allPass = allPass && pass;
            console.log(
                `players=${String(playerCount).padStart(2)} payload=${String(result.payloadBytes).padStart(4)}B ` +
                    `${pass ? "PASS" : "FAIL"}  ` +
                    `${Math.round(result.turnsPerSec).toLocaleString("en-US")} turns/s  ` +
                    `${result.relayedMbPerSec.toFixed(1)} MB/s relayed  ` +
                    `latency avg ${avg.toFixed(2)}ms p95 ${p95.toFixed(2)}ms ` +
                    `max ${max.toFixed(2)}ms`,
            );
        }
    }

    console.log(
        allPass
            ? `\nALL SCENARIOS PASSED (>= ${MIN_TURNS_PER_SEC} turns/s)`
            : `\nSOME SCENARIOS FAILED (floor: ${MIN_TURNS_PER_SEC} turns/s)`,
    );
    server.stop(true);
    process.exit(allPass ? 0 : 1);
}

main().catch(error => {
    console.error("BENCHMARK ERROR:", error);
    server.stop(true);
    process.exit(1);
});
