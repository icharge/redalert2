import { AccountStore } from "../auth/accountStore";
import { SessionManager } from "../auth/session";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ServerConfig } from "../config";
import { Logger, makeLogger } from "../logger";
import { randomHex } from "../util/random";
import { FixedWindowLimiter } from "../util/rateLimit";
import { LadderError, LadderService } from "../ladder/LadderService";
import { isLadderType, WolGameReportResult } from "../ladder/LadderService";
import { decodeGameRes, GameResDecodeError, GameResType } from "../ladder/gameResCodec";
import { GservManager } from "../gserv/GservManager";
import { WolServer } from "../server/WolServer";
import { numeric, WOL_SERVER_NAME } from "../protocol/replies";
import * as Code from "../protocol/wolCodes";
import { handleAdmin } from "./adminRoutes";
import { corsHeaders, withCors } from "./cors";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function httpUrlOf(externalUrl: string): string {
    return externalUrl.replace(/^wss/, "https").replace(/^ws/, "http");
}

// The externalUrl a client should actually use to reach this server: honors
// X-Forwarded-Host/-Proto (set by vite's dev proxy with xfwd, or a real
// reverse proxy) so /servers.ini advertises whichever origin the browser is
// actually connected through, instead of a single value fixed at server
// startup — a dev server reachable at once at localhost, 127.0.0.1, and a
// LAN IP would otherwise only ever work correctly from one of them.
function externalUrlFor(req: Request, config: ServerConfig): string {
    const fwdHost = req.headers.get("x-forwarded-host");
    if (!fwdHost) {
        return config.externalUrl;
    }
    const fwdProto = req.headers.get("x-forwarded-proto");
    const wsProto = fwdProto === "https" ? "wss" : fwdProto === "http" ? "ws" : config.externalUrl.startsWith("wss") ? "wss" : "ws";
    return `${wsProto}://${fwdHost}`;
}

// The actual game WebSocket can't go through a dev proxy in front of this
// server — see vite.config.ts's backendProxy comment for why HTTPS + Vite's
// dev server + WebSocket proxying don't mix (an unfixable-via-config Vite
// limitation, not something specific to this app) — so when a request
// arrived through one (X-Forwarded-Host present, set by vite's xfwd: true),
// wolUrl is redirected to this backend's own port instead of the proxied
// one, keeping whichever hostname the browser is actually on. With no
// X-Forwarded-Host, config.externalUrl is used completely as-is: that
// covers both a bare direct connection AND production behind nginx/
// Cloudflare, where externalUrl's port (typically 443, implicit) is the
// public-facing one, not config.port — forcing config.port there would be
// wrong, nginx and this backend are not usually on the same port.
function wolExternalUrlFor(req: Request, config: ServerConfig): string {
    const fwdHost = req.headers.get("x-forwarded-host");
    if (!fwdHost) {
        return config.externalUrl;
    }
    const fwdProto = req.headers.get("x-forwarded-proto");
    const scheme = fwdProto === "https" ? "wss" : fwdProto === "http" ? "ws" : config.externalUrl.startsWith("wss") ? "wss" : "ws";
    const hostname = fwdHost.replace(/:\d+$/, "");
    return `${scheme}://${hostname}:${config.port}`;
}

function remoteOf(req: Request): string {
    return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("cf-connecting-ip") ?? "-";
}

// Limiters are stateful, so keep one pair per config object (config is fixed
// per process; tests pass their own config objects and get fresh limiters).
const limitersByConfig = new WeakMap<ServerConfig, { login: FixedWindowLimiter; register: FixedWindowLimiter }>();

function limitersFor(config: ServerConfig): { login: FixedWindowLimiter; register: FixedWindowLimiter } {
    let entry = limitersByConfig.get(config);
    if (!entry) {
        entry = {
            login: new FixedWindowLimiter(config.loginMaxPerMin, 60_000),
            register: new FixedWindowLimiter(config.registerMaxPerHour, 3_600_000),
        };
        limitersByConfig.set(config, entry);
    }
    return entry;
}

// Drop cached rate-limit windows so a config reload takes effect immediately.
export function resetRateLimiters(config: ServerConfig): void {
    limitersByConfig.delete(config);
}

// Everything the HTTP layer needs beyond the config. Kept as one object so
// route handlers stay free of positional-argument drift as deps grow.
export interface HttpDeps {
    accounts: AccountStore;
    sessions: SessionManager;
    ladder: LadderService;
    gservs: GservManager;
    wol: WolServer;
}

export async function handleHttp(req: Request, deps: HttpDeps, config: ServerConfig, log: Logger = makeLogger("error", "http")): Promise<Response> {
    const url = new URL(req.url);
    const ip = remoteOf(req);
    log.debug(`http ${req.method} ${url.pathname} from ${ip}`);

    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(config, req) });
    }

    if (req.method === "POST" && url.pathname === "/login") {
        if (!limitersFor(config).login.allow(ip)) {
            log.warn(`login rate limited for ${ip}`);
            return withCors(json({ error: "Too many attempts, try again later", errorCode: "rate_limited" }, 429), config, req);
        }
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            log.warn(`login: invalid request body from ${ip}`);
            return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }), config, req);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        const account = await deps.accounts.verify(user, pass);
        if (!account) {
            log.warn(`login failed for "${user}" from ${ip} (invalid credentials)`);
            return withCors(json({ error: "Invalid username or password", errorCode: "invalid_credentials" }), config, req);
        }
        if (account.banned) {
            log.warn(`login blocked for banned account "${user}" from ${ip}`);
            return withCors(json({ error: "Account is banned", errorCode: "banned_from_server" }), config, req);
        }
        const sessionToken = deps.sessions.create(account.username);
        log.info(`login ok "${account.username}" from ${ip}`);
        return withCors(json({ user: account.username, sessionToken }), config, req);
    }

    if (req.method === "POST" && url.pathname === "/register") {
        if (!limitersFor(config).register.allow(ip)) {
            log.warn(`register rate limited for ${ip}`);
            return withCors(json({ error: "Too many accounts, try again later", errorCode: "rate_limited" }, 429), config, req);
        }
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            log.warn(`register: invalid request body from ${ip}`);
            return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }), config, req);
        }
        const user = String(body.user ?? "");
        const pass = String(body.pass ?? "");
        try {
            const account = await deps.accounts.register(user, pass);
            const sessionToken = deps.sessions.create(account.username);
            log.info(`register ok "${account.username}" from ${ip}`);
            return withCors(json({ user: account.username, sessionToken }), config, req);
        }
        catch (error) {
            log.warn(`register failed for "${user}" from ${ip}: ${String((error as Error).message)}`);
            return withCors(json({ error: String((error as Error).message), errorCode: "registration_failed" }), config, req);
        }
    }

    if (req.method === "GET" && url.pathname === "/servers.ini") {
        const externalUrl = externalUrlFor(req, config);
        const baseUrl = httpUrlOf(externalUrl);
        const wsUrl = wolExternalUrlFor(req, config) + config.wolUrlPath;
        const ini = `[local]
label="Local Dev"
available=yes
gameVersion=${config.gameVersion}
wolUrl="${wsUrl}"
apiLoginUrl="${baseUrl}/login"
apiRegUrl="${baseUrl}/register"
wladderUrl="${baseUrl}/ladder"
wgameresUrl="${baseUrl}/wgameres"
`;
        return withCors(new Response(ini, { headers: { "Content-Type": "text/plain" } }), config, req);
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts[0] === "admin") {
        return handleAdmin(req, {
            sessions: deps.sessions,
            ladder: deps.ladder,
            accounts: deps.accounts,
            wol: deps.wol,
            replaysDir: config.replaysDir,
        }, config, pathParts, log);
    }
    // GET /replays/{gameId} — public .rpl download powering the in-game
    // replay deeplink (#/replay/...). Replays are game recordings, not
    // sensitive; no auth (the admin console still has its own download).
    if (req.method === "GET" && pathParts[0] === "replays" && pathParts.length === 2) {
        const match = deps.ladder.getMatch(pathParts[1]);
        if (!match || match.replayPath === "") {
            return withCors(json({ error: "Replay not found" }, 404), config, req);
        }
        try {
            const content = readFileSync(path.join(config.replaysDir, match.replayPath));
            return withCors(new Response(content, {
                status: 200,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            }), config, req);
        }
        catch {
            return withCors(json({ error: "Replay file missing on disk" }, 404), config, req);
        }
    }
    if (pathParts[0] === "ladder") {
        return handleLadder(req, deps, config, pathParts, log);
    }
    if (req.method === "POST" && pathParts[0] === "wgameres") {
        return handleWgameres(req, deps, config, pathParts, log);
    }

    if (req.method === "GET" && url.pathname === "/auth/session") {
        return withCors(json({ error: "no session" }, 401), config, req);
    }

    if (req.method === "GET" && url.pathname === "/auth/csrf") {
        return withCors(json({ csrfToken: randomHex(16) }, 200), config, req);
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
        try {
            const body: any = await req.json();
            if (typeof body?.sessionToken === "string" && body.sessionToken) {
                deps.sessions.revoke(body.sessionToken);
                log.info(`session revoked via logout for ${ip}`);
            }
        }
        catch {
            // Empty body (upstream realm flow posts with no payload) is fine.
        }
        return withCors(new Response(null, { status: 204 }), config, req);
    }

    if (req.method === "GET" && url.pathname === "/health") {
        return withCors(json({ status: "ok", accounts: deps.accounts.size(), sessions: deps.sessions.size() }), config, req);
    }

    return withCors(new Response("Not Found", { status: 404 }), config, req);
}

function handleLadder(req: Request, deps: HttpDeps, config: ServerConfig, parts: string[], log: Logger): Response | Promise<Response> {
    // /ladder/{sku}
    if (parts.length === 2 && req.method === "GET") {
        const sku = Number(parts[1]);
        const seasons = deps.ladder.getSeasons(sku);
        return seasons === undefined
            ? ladder404(config, req)
            : withCors(json(seasons), config, req);
    }
    // /ladder/{sku}/{season}
    if (parts.length === 3 && req.method === "GET") {
        const sku = Number(parts[1]);
        const season = decodeURIComponent(parts[2]);
        const details = deps.ladder.getSeason(sku, season);
        return details === undefined
            ? ladder404(config, req)
            : withCors(json(details), config, req);
    }
    // /ladder/{sku}/{ladderType}/{season}/listsearch | rungsearch
    if (parts.length === 5 && req.method === "POST") {
        const sku = Number(parts[1]);
        const ladderType = parts[2];
        const season = decodeURIComponent(parts[3]);
        const action = parts[4];
        if (!isLadderType(ladderType)) {
            return ladder404(config, req);
        }
        return req.json()
            .then((body: any) => {
                if (action === "listsearch") {
                    const players = Array.isArray(body?.players)
                        ? body.players.map((name: unknown) => String(name))
                        : [];
                    const profiles = deps.ladder.listSearch(sku, ladderType, season, players);
                    return profiles === undefined
                        ? ladder404(config, req)
                        : withCors(json(profiles), config, req);
                }
                if (action === "rungsearch") {
                    const page = deps.ladder.rungSearch(
                        sku,
                        ladderType,
                        season,
                        String(body?.ladderId ?? ""),
                        Number(body?.start ?? 1),
                        Number(body?.count ?? 20),
                    );
                    return page === undefined
                        ? ladder404(config, req)
                        : withCors(json(page), config, req);
                }
                return withCors(json({ error: "Not Found" }, 404), config, req);
            })
            .catch(() => withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }, 400), config, req));
    }
    log.warn(`ladder: unexpected request ${req.method} /${parts.join("/")}`);
    return ladder404(config, req);
}

function ladder404(config: ServerConfig, req: Request): Response {
    return withCors(json({ error: "Not Found", errorCode: "not_found" }, 404), config, req);
}

/**
 * POST /wgameres/{sku} — the client-reported game result
 * (GameRes.toBinary(), base64-encoded, Bearer session token).
 *
 * Validation chain (any failure is terminal for the client's retry loop, so
 * no-score cases are 4xx):
 *   1. session token -> account
 *   2. packet decodes; GMID matches a ranked gserv instance whose roster
 *      equals the report players exactly
 *   3. reporter account matches the packet's account name (SNAM)
 *   4. tournament game, finished, not out of sync, not a short game
 *   5. duration >= minReportDurationSeconds (anti-farm)
 *   6. outcomes are complementary (win/loss or all-draw), enforced per-ladder
 *      shape in LadderService.recordMatch
 *
 * On success the standings are updated once (idempotent) and a 730 game report
 * is pushed to every player with an active WOL session.
 */
async function handleWgameres(req: Request, deps: HttpDeps, config: ServerConfig, parts: string[], log: Logger): Promise<Response> {
    const sku = Number(parts[1]);
    if (!Number.isInteger(sku)) {
        return withCors(json({ error: "Invalid sku", errorCode: "invalid_request" }, 400), config, req);
    }
    const authorization = req.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const session = deps.sessions.validate(token);
    if (!session) {
        log.warn(`wgameres: unauthenticated report from ${remoteOf(req)}`);
        return withCors(json({ error: "Unauthorized", errorCode: "unauthorized" }, 401), config, req);
    }

    let body: string;
    try {
        body = (await req.text()).trim();
    }
    catch {
        return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }, 400), config, req);
    }
    if (!isBase64(body)) {
        return withCors(json({ error: "Invalid request body", errorCode: "invalid_request" }, 400), config, req);
    }

    let report: ReturnType<typeof decodeGameRes>;
    try {
        report = decodeGameRes(new Uint8Array(Buffer.from(body, "base64")));
    }
    catch (error) {
        if (error instanceof GameResDecodeError) {
            log.warn(`wgameres: ${error.message} from ${session.username}`);
            return withCors(json({ error: "Invalid game report", errorCode: "invalid_report" }, 400), config, req);
        }
        throw error;
    }
    if (report.sku !== sku) {
        log.warn(`wgameres: sku mismatch (url ${sku}, packet ${report.sku}) from ${session.username}`);
        return withCors(json({ error: "Invalid game report", errorCode: "invalid_report" }, 400), config, req);
    }
    if (report.accountName !== session.username) {
        log.warn(`wgameres: report account "${report.accountName}" does not match session "${session.username}"`);
        return withCors(json({ error: "Invalid game report", errorCode: "invalid_report" }, 400), config, req);
    }

    const instance = deps.gservs.get(report.gameId);
    if (!instance || !instance.ranked || !instance.ladderType) {
        log.warn(`wgameres: unknown or unranked instance ${report.gameId} from ${session.username}`);
        return withCors(json({ error: "Not Found", errorCode: "not_found" }, 404), config, req);
    }
    if (instance.endedAt !== undefined && Math.floor(Date.now() / 1000) - instance.endedAt > config.gservReportWindowSeconds) {
        log.warn(`wgameres: report for ${report.gameId} arrived after the report window closed`);
        return withCors(json({ error: "Not Found", errorCode: "not_found" }, 404), config, req);
    }
    if (!isLadderType(instance.ladderType)) {
        log.error(`wgameres: instance ${report.gameId} has malformed ladder type "${instance.ladderType}"`);
        return withCors(json({ error: "Not Found", errorCode: "not_found" }, 404), config, req);
    }
    const ladderType = instance.ladderType;
    if (!samePlayers(instance.players, report.players.map(player => player.name))) {
        log.warn(`wgameres: roster mismatch for ${report.gameId} (instance ${instance.players.join(", ")} vs report ${report.players.map(player => player.name).join(", ")})`);
        return withCors(json({ error: "Invalid game report", errorCode: "invalid_report" }, 400), config, req);
    }
    if (!report.tournament) {
        log.debug(`wgameres: non-tournament report for ${report.gameId} ignored`);
        return withCors(json({ error: "Not a ranked game", errorCode: "not_ranked" }, 400), config, req);
    }
    if (!report.finished || report.outOfSync || report.shortGame) {
        log.debug(`wgameres: non-scoring report for ${report.gameId} (finished=${report.finished}, oos=${report.outOfSync}, short=${report.shortGame})`);
        return withCors(json({ error: "Game did not finish", errorCode: "not_finished" }, 400), config, req);
    }
    if (report.duration < config.minReportDurationSeconds) {
        log.warn(`wgameres: ${report.gameId} too short (${report.duration}s < ${config.minReportDurationSeconds}s) from ${session.username}`);
        return withCors(json({ error: "Game too short", errorCode: "too_short" }, 400), config, req);
    }

    const results = report.players.map(player => completionToResult(player.completionStatus));
    if (results.some(result => result === undefined)) {
        log.warn(`wgameres: ${report.gameId} has incomplete completion statuses`);
        return withCors(json({ error: "Incomplete game report", errorCode: "invalid_report" }, 400), config, req);
    }
    const players = report.players.map((player, index) => ({ name: player.name, resultType: results[index]! }));

    let scored: ReturnType<LadderService["recordMatch"]>;
    try {
        scored = deps.ladder.recordMatch({
            sku,
            gameId: report.gameId,
            ladderType,
            duration: report.duration,
            mapName: report.mapName,
            replayPath: findReplayFile(config.replaysDir, report.gameId),
            players,
        });
    }
    catch (error) {
        if (error instanceof LadderError) {
            log.warn(`wgameres: ${error.message} for ${report.gameId} from ${session.username}`);
            return withCors(json({ error: error.message, errorCode: "invalid_report" }, error.statusCode), config, req);
        }
        throw error;
    }

    const payload = Buffer.from(JSON.stringify(scored)).toString("base64");
    for (const player of scored.players) {
        const user = deps.wol.users.get(player.name);
        if (user) {
            user.send(numeric(WOL_SERVER_NAME, Code.RPL_GAME_REPORT, player.name, [], payload));
            log.debug(`wgameres: pushed 730 to ${player.name} for ${report.gameId}`);
        }
    }
    log.info(`wgameres: scored ${report.gameId} (${instance.ladderType}) for ${session.username}`);
    return withCors(json(scored), config, req);
}

function completionToResult(status: number): WolGameReportResult | undefined {
    switch (status) {
        case GameResType.Win:
            return WolGameReportResult.Win;
        case GameResType.Loss:
        case GameResType.Resign:
        case GameResType.Disconnect:
        case GameResType.ConnectionLost:
            return WolGameReportResult.Loss;
        case GameResType.Draw:
            return WolGameReportResult.Draw;
        default:
            return undefined;
    }
}

function samePlayers(instancePlayers: string[], reportPlayers: string[]): boolean {
    if (instancePlayers.length !== reportPlayers.length) {
        return false;
    }
    const expected = new Set(instancePlayers.map(name => name.toLowerCase()));
    return reportPlayers.every(name => expected.has(name.toLowerCase()));
}

function isBase64(value: string): boolean {
    return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

// Replay files are named "game-<gameId> <ISO timestamp>.rpl" (see
// GservReplayRecorder.finalize). Returns the file name when one exists.
function findReplayFile(replaysDir: string, gameId: string): string | undefined {
    const prefix = `game-${gameId} `;
    try {
        const files = readdirSync(replaysDir);
        return files.find(file => file.startsWith(prefix) && file.endsWith(".rpl"));
    }
    catch {
        return undefined;
    }
}
