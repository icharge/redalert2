import { loadConfig, ServerConfig } from "./config";
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
const accounts = new AccountStore(config);
const sessions = new SessionManager(config.sessionTtlSeconds);
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
                return new Response("Forbidden", { status: 403 });
            }
            const url = new URL(req.url);
            const target: WsData["target"] = url.pathname.startsWith(config.gservUrlPath) ? "gserv" : "wol";
            const upgraded = srv.upgrade(req, { data: { target } });
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
        }
        return handleHttp(req, accounts, sessions, config);
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
console.log(`[ra2web-server] Wol server listening on ws://${server.hostname}:${server.port}`);
console.log(`[ra2web-server] Http endpoints on ${httpProtocol}://${server.hostname}:${server.port} (/login /register /servers.ini /health)`);
console.log(`[ra2web-server] Gserv endpoint at ${config.externalUrl}${config.gservUrlPath}`);
