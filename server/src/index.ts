import { loadConfig, ServerConfig } from "./config";
import { makeLogger } from "./logger";
import { createStorage } from "./storage";
import { AccountStore } from "./auth/accountStore";
import { SessionManager } from "./auth/session";
import { WolServer } from "./server/WolServer";
import { ServerUser } from "./server/ServerUser";
import { GservServer, GservClient } from "./gserv/GservServer";
import { GservManager } from "./gserv/GservManager";
import { handleHttp } from "./http/routes";
import { isOriginAllowed } from "./http/cors";

interface WsData {
    target: "wol" | "gserv";
    user?: ServerUser;
    client?: GservClient;
}

const config = loadConfig();
const log = makeLogger(config.logLevel, "ra2web");
const storage = createStorage(config);
const accounts = new AccountStore(storage, config);
const sessions = new SessionManager(storage, config.sessionTtlSeconds);
const gservManager = new GservManager({ id: config.gservId, url: config.externalUrl + config.gservUrlPath });
const wol = new WolServer(config, sessions, accounts, gservManager);
const gserv = new GservServer(config, gservManager);

wol.startPingLoop();

const server = Bun.serve<WsData>({
    hostname: config.host,
    port: config.port,
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

