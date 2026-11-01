import { loadConfig, ServerConfig } from "./config";
import { makeLogger, fileLogOptionsOf, Logger } from "./logger";
import { createStorage } from "./storage";
import { Storage } from "./storage/Storage";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AccountStore } from "./auth/accountStore";
import { SessionManager } from "./auth/session";
import { WolServer } from "./server/WolServer";
import { WolTcpGateway } from "./server/WolTcpGateway";
import { ServerUser } from "./server/ServerUser";
import { GservServer, GservClient } from "./gserv/GservServer";
import { GservManager } from "./gserv/GservManager";
import { NativeRelay, NativeRelayClient } from "./gserv/NativeRelay";
import { LadderService } from "./ladder/LadderService";
import { handleHttp, HttpDeps } from "./http/routes";
import { resetRateLimiters } from "./http/routes";
import { MapStore } from "./mapstore/MapStore";
import { openDatabase } from "./auth/db";
import { isOriginAllowed } from "./http/cors";
import { WdtService } from "./wdt/service";
import { WdtTcpServer } from "./wdt/server";
import { createWdtStore } from "./wdt/store";

interface WsData {
    target: "wol" | "gserv" | "native";
    user?: ServerUser;
    client?: GservClient;
    relay?: NativeRelayClient;
}

const config = loadConfig();
const log = makeLogger(config.logLevel, "ra2web", fileLogOptionsOf(config));
const storage = createStorage(config);
const accounts = new AccountStore(storage, config);
const sessions = new SessionManager(storage, config.sessionTtlSeconds);
const gservManager = new GservManager({ id: config.gservId, url: config.externalUrl + config.gservUrlPath });
// World Domination Tour: one cycle service, shared by the WOL bridge (HTTP)
// and the native TCP listener. The browser fetches /wdt/state; native clients
// connect to WDT_HOST:WDT_PORT from the server-list MGL entry.
const wdt = new WdtService({
    edition: process.env.WDT_EDITION === "yr" ? "yr" : "ra2",
    url: process.env.WDT_URL ?? config.externalUrl.replace(/^ws/, "http") + "/wdt",
    store: createWdtStore(config),
});
const wol = new WolServer(config, sessions, accounts, gservManager, wdt);
const gserv = new GservServer(config, gservManager);
const nativeRelay = new NativeRelay(gservManager, makeLogger(config.logLevel, "native-relay", fileLogOptionsOf(config)), undefined, config.nativeRelayTestDelayMs);
const ladder = new LadderService(storage, makeLogger(config.logLevel, "ladder", fileLogOptionsOf(config)), {
    startingRating: config.startingRating,
    placementMatches: config.placementMatches,
});
const wdtServer = config.wdtEnabled
    ? new WdtTcpServer(wdt, { host: config.wdtHost, port: config.wdtPort })
    : undefined;
const wolTcp = config.wolTcpEnabled
    ? new WolTcpGateway(wol, { host: config.wolTcpHost, port: config.wolTcpPort })
    : undefined;
const httpDeps: HttpDeps = {
    accounts,
    sessions,
    ladder,
    gservs: gservManager,
    wol,
    wdt,
    replaySnapshot: (gameId) => gserv.getReplaySnapshot(gameId),
    maps: config.mapServiceEnabled ? new MapStore(openDatabase(config.dbPath), {
        mapsDir: config.mapsDir,
        maxUploadBytes: config.mapMaxUploadBytes,
    }) : undefined,
};

// Archive every finished game (public + ranked) with its replay file name so
// the admin console can list and serve replays. Ranked reports later upgrade
// the same row to a scored match.
gserv.onMatchArchived = (event) => {
    ladder.archivePublicMatch({
        gameId: event.gameId,
        reportedAt: event.timestamp * 1000,
        players: event.players,
        replayPath: event.replayFileName,
    });
};
backfillReplayPaths(storage, config.replaysDir, ladder, log);

wol.startPingLoop();
gserv.startSweepLoop();
if (wdtServer) {
    try {
        const address = await wdtServer.start();
        log.info(`World Domination listener on tcp://${address.host}:${address.port} (state also at /wdt/state)`);
    }
    catch (error) {
        log.warn(`World Domination listener did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
}
if (wolTcp) {
    try {
        const address = await wolTcp.start();
        log.info(`Native WOL gateway on tcp://${address.host}:${address.port} (same accounts, channels and games as the WebSocket lobby)`);
    }
    catch (error) {
        log.warn(`Native WOL gateway did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Shares the same self-signed cert vite's dev server uses/auto-generates
// (see scripts/dev-all.mjs), so a client served over https:// can reach this
// server without hitting mixed-content blocking. Opt-in: absent in
// production, where TLS is terminated by nginx/Cloudflare in front of a
// plain-HTTP Bun process (see server/nginx.conf).
const certsDir = path.join(import.meta.dir, "..", "..", "certs");
const tlsKeyPath = path.join(certsDir, "server.key");
const tlsCertPath = path.join(certsDir, "server.crt");
const tls = existsSync(tlsKeyPath) && existsSync(tlsCertPath)
    ? { key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) }
    : undefined;

const server = Bun.serve<WsData>({
    hostname: config.host,
    port: config.port,
    // Allow map uploads/transfers to exceed the (small) chat payload cap; the
    // per-request size is still bounded by config.mapMaxUploadBytes in the store.
    maxRequestBodySize: Math.max(config.maxPayloadBytes, config.mapMaxUploadBytes),
    tls,
    fetch(req, srv) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            if (!isOriginAllowed(config, req)) {
                log.warn(`WebSocket upgrade rejected: origin "${req.headers.get("origin") ?? "<none>"}" not allowed`);
                return new Response("Forbidden", { status: 403 });
            }
            const url = new URL(req.url);
            const target: WsData["target"] = url.pathname === config.gservUrlPath + "/native" ? "native"
                : url.pathname.startsWith(config.gservUrlPath) ? "gserv" : "wol";
            const upgraded = srv.upgrade(req, { data: { target } });
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
        }
        return handleHttp(req, httpDeps, config, log);
    },
    websocket: {
        maxPayloadLength: config.maxPayloadBytes,
        open(ws) {
            if (ws.data.target === "native") {
                ws.data.relay = nativeRelay.handleOpen(ws);
            }
            else if (ws.data.target === "gserv") {
                ws.data.client = gserv.handleOpen(ws);
            }
            else {
                ws.data.user = wol.handleOpen(ws);
            }
        },
        message(ws, message) {
            if (ws.data.target === "native") {
                if (ws.data.relay) {
                    nativeRelay.handleMessage(ws.data.relay, message);
                }
            }
            else if (ws.data.target === "gserv") {
                if (ws.data.client) {
                    gserv.handleMessage(ws.data.client, message);
                }
            }
            else if (typeof message === "string" && ws.data.user) {
                wol.handleMessage(ws.data.user, message);
            }
        },
        close(ws) {
            if (ws.data.target === "native") {
                if (ws.data.relay) {
                    nativeRelay.handleClose(ws.data.relay);
                }
            }
            else if (ws.data.target === "gserv") {
                if (ws.data.client) {
                    gserv.handleClose(ws.data.client);
                }
            }
            else if (ws.data.user) {
                wol.handleClose(ws.data.user);
            }
        },
    },
});

const wsProtocol = tls ? "wss" : "ws";
const httpProtocol = tls ? "https" : "http";
log.info(`Wol server listening on ${wsProtocol}://${server.hostname}:${server.port}${tls ? " (TLS)" : ""}`);
log.info(`Http endpoints on ${httpProtocol}://${server.hostname}:${server.port} (/login /register /ladder /wgameres /servers.ini /health)`);
log.info(`Gserv endpoint at ${config.externalUrl}${config.gservUrlPath}`);
log.info(`Log level: ${config.logLevel}`);
if (config.logFilePath) {
    const triggers = [`${config.logMaxBytes} bytes`];
    if (config.logRotateDaily) {
        triggers.push("daily");
    }
    log.info(`Log file: ${config.logFilePath} (rotate at ${triggers.join(" or ")}, keep ${config.logMaxFiles} backup(s))`);
}
else {
    log.info("Log file: disabled (set LOG_FILE to enable)");
}
if (config.storageEngine === "sqlite") {
    log.info(`Storage: sqlite db at ${config.dbPath}`);
}
else {
    log.info("Storage: memory (no persistence)");
}
log.info(`Replays: ${config.recordReplays ? `recording to ${config.replaysDir}` : "disabled"}`);
log.info(`Ladder: rating ${config.startingRating}, ${config.placementMatches} placement game(s), min report ${config.minReportDurationSeconds}s, report window ${config.gservReportWindowSeconds}s`);
log.info(`Session TTL: ${config.sessionTtlSeconds}s | ping interval: ${config.pingIntervalSeconds}s | max payload: ${config.maxPayloadBytes} bytes`);

let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    log.info(`received ${signal}; shutting down`);
    wol.dispose();
    gserv.dispose();
    nativeRelay.dispose();
    void wdtServer?.close();
    void wolTcp?.close();
    server.stop(true);
    storage.close();
    process.exit(0);
}

// Settings that are fixed when the sockets bind or the storage opens; they
// require a full restart to change.
const RESTART_ONLY_KEYS = [
    "host",
    "port",
    "externalUrl",
    "gservUrlPath",
    "maxPayloadBytes",
    "storageEngine",
    "dbPath",
    "logFilePath",
    "logMaxBytes",
    "logMaxFiles",
    "logRotateDaily",
    "wolTcpEnabled",
    "wolTcpHost",
    "wolTcpPort",
] as const;

// Hot reload for `systemctl reload` / `kill -HUP`: re-reads env + .env files
// and applies changes to the live config object. Existing WebSocket
// connections, lobby sessions and in-progress game instances are kept as-is;
// only settings read at connection/action time change behavior (motd, channel
// pass, mod hash, net rate, rate limits, ping interval, log level, CORS).
function reload(signal: string): void {
    const fresh = loadConfig();
    const restartOnly: string[] = [];
    for (const key of RESTART_ONLY_KEYS) {
        if (fresh[key] !== config[key]) {
            restartOnly.push(`${key} (${String(config[key])} -> ${String(fresh[key])})`);
        }
    }
    if (fresh.logLevel !== config.logLevel) {
        log.level = fresh.logLevel;
        wol.log.level = fresh.logLevel;
        gserv.log.level = fresh.logLevel;
    }
    const pingChanged = fresh.pingIntervalSeconds !== config.pingIntervalSeconds;
    Object.assign(config, fresh);
    resetRateLimiters(config);
    if (pingChanged) {
        wol.refreshPingLoop();
    }
    if (restartOnly.length) {
        log.warn(`reload: ${restartOnly.join("; ")} require a full restart to apply`);
    }
    log.info(`config reloaded (${signal}); connections and game sessions were kept`);
}

// On boot, link existing replay files on disk to their match archive rows so
// history from before the archive existed stays browsable and downloadable.
function backfillReplayPaths(storage: Storage, replaysDir: string, ladder: LadderService, log: Logger): void {
    let files: string[];
    try {
        files = readdirSync(replaysDir);
    }
    catch {
        return;
    }
    let linked = 0;
    for (const file of files) {
        if (!file.endsWith(".rpl") || !file.startsWith("game-")) {
            continue;
        }
        const gameId = file.slice("game-".length).split(" ")[0];
        if (ladder.linkReplayFile(gameId, file, Date.now())) {
            linked += 1;
        }
    }
    if (linked > 0) {
        log.info(`backfill: linked ${linked} replay file(s) in ${replaysDir}`);
    }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
if (process.platform !== "win32") {
    process.on("SIGHUP", () => reload("SIGHUP"));
}

