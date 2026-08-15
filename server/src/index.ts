import { loadConfig, ServerConfig } from "./config";
import { makeLogger, fileLogOptionsOf } from "./logger";
import { createStorage } from "./storage";
import { AccountStore } from "./auth/accountStore";
import { SessionManager } from "./auth/session";
import { WolServer } from "./server/WolServer";
import { ServerUser } from "./server/ServerUser";
import { GservServer, GservClient } from "./gserv/GservServer";
import { GservManager } from "./gserv/GservManager";
import { handleHttp } from "./http/routes";
import { resetRateLimiters } from "./http/routes";
import { isOriginAllowed } from "./http/cors";

interface WsData {
    target: "wol" | "gserv";
    user?: ServerUser;
    client?: GservClient;
}

const config = loadConfig();
const log = makeLogger(config.logLevel, "ra2web", fileLogOptionsOf(config));
const storage = createStorage(config);
const accounts = new AccountStore(storage, config);
const sessions = new SessionManager(storage, config.sessionTtlSeconds);
const gservManager = new GservManager({ id: config.gservId, url: config.externalUrl + config.gservUrlPath });
const wol = new WolServer(config, sessions, accounts, gservManager);
const gserv = new GservServer(config, gservManager);

wol.startPingLoop();
gserv.startSweepLoop();

const server = Bun.serve<WsData>({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: config.maxPayloadBytes,
    fetch(req, srv) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            if (!isOriginAllowed(config, req)) {
                log.warn(`WebSocket upgrade rejected: origin "${req.headers.get("origin") ?? "<none>"}" not allowed`);
                return new Response("Forbidden", { status: 403 });
            }
            const url = new URL(req.url);
            const target: WsData["target"] = url.pathname.startsWith(config.gservUrlPath) ? "gserv" : "wol";
            const upgraded = srv.upgrade(req, { data: { target } });
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
        }
        return handleHttp(req, accounts, sessions, config, log);
    },
    websocket: {
        maxPayloadLength: config.maxPayloadBytes,
        open(ws) {
            if (ws.data.target === "gserv") {
                ws.data.client = gserv.handleOpen(ws);
            }
            else {
                ws.data.user = wol.handleOpen(ws);
            }
        },
        message(ws, message) {
            if (ws.data.target === "gserv") {
                if (ws.data.client) {
                    gserv.handleMessage(ws.data.client, message);
                }
            }
            else if (typeof message === "string" && ws.data.user) {
                wol.handleMessage(ws.data.user, message);
            }
        },
        close(ws) {
            if (ws.data.target === "gserv") {
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

const httpProtocol = config.externalUrl.startsWith("wss") ? "https" : "http";
log.info(`Wol server listening on ws://${server.hostname}:${server.port}`);
log.info(`Http endpoints on ${httpProtocol}://${server.hostname}:${server.port} (/login /register /servers.ini /health)`);
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

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
if (process.platform !== "win32") {
    process.on("SIGHUP", () => reload("SIGHUP"));
}

