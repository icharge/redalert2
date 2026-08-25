// Admin console API: season management, dashboard stats, match browsing and
// player search/history. Every route requires a valid session token whose
// username is listed in ADMIN_USERNAMES. These handlers are thin HTTP
// adapters over the LadderService domain facade, so the whole console could
// be extracted into its own service without touching the domain code.

import { ServerConfig } from "../config";
import { Session, SessionManager } from "../auth/session";
import { AccountStore } from "../auth/accountStore";
import { LadderService, isLadderType } from "../ladder/LadderService";
import { WolServer } from "../server/WolServer";
import { MapStore } from "../mapstore/MapStore";
import { Logger } from "../logger";
import { statSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { withCors } from "./cors";

export interface AdminDeps {
    sessions: SessionManager;
    ladder: LadderService;
    accounts: AccountStore;
    wol: WolServer;
    replaysDir: string;
    maps?: MapStore;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export async function handleAdmin(req: Request, deps: AdminDeps, config: ServerConfig, parts: string[], log: Logger): Promise<Response> {
    const session = requireAdmin(deps, config, req, log);
    if (!session) {
        return withCors(json({ error: "Unauthorized" }, 401), config, req);
    }
    // parts[0] === "admin"; season id lives at parts[2] for the close route.
    const action = parts[1];
    const segment = parts[2];

    switch (action) {
        case "config": {
            // Advertises the game client origin (CLIENT_URL) and this server's
            // own API origin so the console can pre-fill its replay links.
            if (req.method === "GET") {
                return withCors(json({
                    clientUrl: config.clientUrl,
                    apiUrl: httpUrlOf(config),
                }), config, req);
            }
            return deny(config, req, "Not Found", 404);
        }
        case "seasons": {
            // POST /admin/seasons/{id}?sku=16640 — edit name/start/end.
            if (req.method === "POST" && parts.length === 3) {
                const id = Number(segment);
                const sku = Number(new URL(req.url).searchParams.get("sku"));
                let body: any;
                try {
                    body = await req.json();
                }
                catch {
                    return deny(config, req, "Invalid request body", 400);
                }
                if (!Number.isInteger(id) || !Number.isInteger(sku)) {
                    return deny(config, req, "Not Found", 404);
                }
                const updated = deps.ladder.updateSeason(sku, id, {
                    name: typeof body?.name === "string" ? body.name : undefined,
                    startTime: Number.isFinite(Number(body?.startTime)) ? Number(body.startTime) : undefined,
                    endTime: Number.isFinite(Number(body?.endTime)) ? Number(body.endTime) : undefined,
                });
                if (!updated) {
                    return deny(config, req, "Season not found or invalid input", 400);
                }
                log.info(`admin: ${session.username} updated season ${id} (sku ${sku})`);
                return withCors(json(updated), config, req);
            }
            // POST /admin/seasons/{id}/close?sku=16640
            if (req.method === "POST" && parts[3] === "close") {
                const id = Number(segment);
                const sku = Number(new URL(req.url).searchParams.get("sku"));
                if (Number.isInteger(id) && Number.isInteger(sku)) {
                    if (!deps.ladder.closeSeason(sku, id)) {
                        return deny(config, req, "Season not found", 404);
                    }
                    log.info(`admin: ${session.username} closed season ${id} (sku ${sku})`);
                    return withCors(json({ ok: true }), config, req);
                }
                return deny(config, req, "Not Found", 404);
            }
            if (req.method === "GET") {
                return withCors(json(deps.ladder.getSeasonsAdmin()), config, req);
            }
            if (req.method === "POST") {
                let body: any;
                try {
                    body = await req.json();
                }
                catch {
                    return deny(config, req, "Invalid request body", 400);
                }
                const name = String(body?.name ?? "").trim();
                const sku = Number(body?.sku);
                if (!name || name.length > 40) {
                    return deny(config, req, "Season name must be 1-40 characters", 400);
                }
                if (!Number.isInteger(sku)) {
                    return deny(config, req, "sku must be an integer", 400);
                }
                const created = deps.ladder.createSeason({
                    name,
                    sku,
                    startTime: Number.isFinite(Number(body?.startTime)) ? Number(body.startTime) : undefined,
                    endTime: Number.isFinite(Number(body?.endTime)) ? Number(body.endTime) : undefined,
                });
                if (!created) {
                    return deny(config, req, "Unknown sku", 400);
                }
                log.info(`admin: ${session.username} created season ${created.id} "${created.name}" (sku ${created.sku})`);
                return withCors(json(created, 201), config, req);
            }
            return deny(config, req, "Not Found", 404);
        }
        case "dashboard": {
            if (req.method === "GET") {
                return withCors(json(deps.ladder.getDashboard()), config, req);
            }
            return deny(config, req, "Not Found", 404);
        }
        case "matches": {
            if (req.method === "GET") {
                const url = new URL(req.url);
                const limit = Number(url.searchParams.get("limit") ?? 50);
                const player = (url.searchParams.get("player") ?? "").trim();
                const matches = deps.ladder.getRecentMatches(limit);
                if (player) {
                    const needle = player.toLowerCase();
                    return withCors(json(matches.filter(match => match.players.some(p => p.name.toLowerCase() === needle))), config, req);
                }
                return withCors(json(matches), config, req);
            }
            return deny(config, req, "Not Found", 404);
        }
        case "replays": {
            // GET /admin/replays?limit=50 — scored + public matches that have
            // a recorded replay file on disk.
            if (req.method === "GET" && segment === undefined) {                const url = new URL(req.url);
                const limit = Number(url.searchParams.get("limit") ?? 50);
                const matches = deps.ladder.getRecentMatches(limit).filter(match => match.replayPath !== "");
                const entries = matches.map(match => {
                    const filePath = path.join(deps.replaysDir, match.replayPath);
                    let sizeBytes = 0;
                    try {
                        sizeBytes = statSync(filePath).size;
                    }
                    catch {
                        // Replay file missing on disk (moved/deleted); keep the row.
                    }
                    return {
                        gameId: match.gameId,
                        seasonId: match.seasonId,
                        ladderType: match.ladderType,
                        reportedAt: match.reportedAt,
                        scored: match.scored,
                        mapName: match.mapName,
                        players: match.players.map(player => ({ name: player.name, resultType: player.resultType })),
                        replayFile: match.replayPath,
                        sizeBytes,
                    };
                });
                return withCors(json(entries), config, req);
            }
            // GET /admin/replays/{gameId} — download the .rpl file.
            if (req.method === "GET" && typeof segment === "string" && segment.length > 0) {
                const match = deps.ladder.getMatch(segment);
                if (!match || match.replayPath === "") {
                    return deny(config, req, "Replay not found", 404);
                }
                const filePath = path.join(deps.replaysDir, match.replayPath);
                let content: Buffer;
                try {
                    content = readFileSync(filePath);
                }
                catch {
                    return deny(config, req, "Replay file missing on disk", 404);
                }
                return new Response(new Uint8Array(content), {
                    status: 200,
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "Content-Disposition": `attachment; filename="${match.replayPath.replace(/"/g, "")}"`,
                        "Content-Length": String(content.length),
                    },
                });
            }
            return deny(config, req, "Not Found", 404);
        }
        // GET /admin/replay-files — raw scan of the replay folder on disk
        // (shows every .rpl, including files not yet linked to the archive).
        // POST /admin/replay-files/backfill — link any unlinked files.
        case "replay-files": {
            if (req.method === "GET") {
                const files = scanReplayFiles(deps.replaysDir);
                return withCors(json(files.map(file => ({
                    ...file,
                    inDb: deps.ladder.getMatch(file.gameId) !== undefined,
                }))), config, req);
            }
            if (req.method === "POST" && segment === "backfill") {
                const files = scanReplayFiles(deps.replaysDir);
                let linked = 0;
                for (const file of files) {
                    if (deps.ladder.linkReplayFile(file.gameId, file.fileName, Math.floor(file.mtimeMs))) {
                        linked += 1;
                    }
                }
                log.info(`admin: ${session.username} linked ${linked} replay file(s)`);
                return withCors(json({ linked }), config, req);
            }
            return deny(config, req, "Not Found", 404);
        }
        case "players": {
            // GET /admin/players?q=alice&limit=20
            if (req.method === "GET" && segment === undefined) {
                const url = new URL(req.url);
                const q = (url.searchParams.get("q") ?? "").trim();
                const limit = Number(url.searchParams.get("limit") ?? 20);
                if (!q) {
                    return deny(config, req, "Missing q parameter", 400);
                }
                return withCors(json(deps.ladder.searchPlayers(q, limit)), config, req);
            }
            // POST /admin/players/{name}/ban? /unban? /reset? — player management
            if (req.method === "POST" && typeof segment === "string" && parts.length === 4) {
                const name = segment;
                const action = parts[3];
                if (action === "ban" || action === "unban") {
                    const banned = action === "ban";
                    const account = deps.accounts.get(name);
                    if (!account) {
                        return deny(config, req, "Player not found", 404);
                    }
                    deps.accounts.setBanned(name, banned);
                    if (banned) {
                        // Revoke sessions and kick an online connection so the
                        // ban takes effect immediately.
                        deps.sessions.revokeByUser(account.username);
                        const user = deps.wol.users.get(account.username);
                        if (user) {
                            user.socket.close(4006, "Banned");
                        }
                    }
                    log.info(`admin: ${session.username} ${banned ? "banned" : "unbanned"} ${account.username}`);
                    return withCors(json({ name: account.username, banned }), config, req);
                }
                if (action === "reset") {
                    const account = deps.accounts.get(name);
                    if (!account) {
                        return deny(config, req, "Player not found", 404);
                    }
                    const result = deps.ladder.resetPlayerStats(name);
                    log.info(`admin: ${session.username} reset ladder stats for ${account.username} (${result.standingsRemoved} standing(s), ${result.matchesRemoved} history row(s))`);
                    return withCors(json({ name: account.username, ...result }), config, req);
                }
                return deny(config, req, "Not Found", 404);
            }
            // GET /admin/players/{name}?season=current&ladderType=1v1
            if (req.method === "GET" && typeof segment === "string" && segment.length > 0) {
                const url = new URL(req.url);
                const season = url.searchParams.get("season") ?? undefined;
                const ladderType = url.searchParams.get("ladderType") ?? undefined;
                if (ladderType !== undefined && !isLadderType(ladderType)) {
                    return deny(config, req, "Unknown ladder type", 400);
                }
                const history = deps.ladder.getPlayerHistory(segment, season, ladderType as any, 50);
                if (!history) {
                    return deny(config, req, "Player not found", 404);
                }
                const account = deps.accounts.get(segment);
                return withCors(json({
                    ...history,
                    account: account ? {
                        username: account.username,
                        banned: account.banned,
                        createdAt: account.createdAt,
                        online: deps.wol.users.has(account.username),
                    } : undefined,
                }), config, req);
            }
            return deny(config, req, "Not Found", 404);
        }
        case "maps": {
            if (!deps.maps) {
                return deny(config, req, "Map service disabled", 404);
            }
            // GET /admin/maps — list all (including hidden) with stats.
            if (req.method === "GET" && parts.length === 2) {
                const url = new URL(req.url);
                const query = url.searchParams.get("q")?.trim() || undefined;
                const sortRaw = url.searchParams.get("sort") ?? "newest";
                const page = Number(url.searchParams.get("page") ?? 1);
                const limit = Number(url.searchParams.get("limit") ?? 50);
                const result = deps.maps.list({
                    query,
                    sort: ["newest", "downloads", "uploads", "plays", "rating"].includes(sortRaw) ? sortRaw as never : "newest",
                    page,
                    limit,
                    includeHidden: true,
                });
                return withCors(json(result), config, req);
            }
            // GET /admin/maps/{id}/meta — metadata + upload log.
            if (req.method === "GET" && parts.length === 4 && parts[3] === "meta") {
                const record = resolveAdminMap(deps.maps, parts[2]);
                if (!record) {
                    return deny(config, req, "Map not found", 404);
                }
                return withCors(json({ ...record, uploadLog: deps.maps.getUploadLog(record.sha256) }), config, req);
            }
            // POST /admin/maps/{id} — edit metadata.
            if (req.method === "POST" && parts.length === 3) {
                let body: any;
                try {
                    body = await req.json();
                }
                catch {
                    return deny(config, req, "Invalid request body", 400);
                }
                const record = resolveAdminMap(deps.maps, parts[2]);
                if (!record) {
                    return deny(config, req, "Map not found", 404);
                }
                const updated = deps.maps.updateMeta(record.sha256, {
                    title: typeof body?.title === "string" ? body.title : undefined,
                    description: typeof body?.description === "string" ? body.description : undefined,
                    official: typeof body?.official === "boolean" ? body.official : undefined,
                    maxPlayers: Number.isInteger(body?.maxPlayers) ? body.maxPlayers : undefined,
                    gameModes: Array.isArray(body?.gameModes) ? body.gameModes.map(String) : undefined,
                    theater: typeof body?.theater === "string" ? body.theater : undefined,
                });
                log.info(`admin: ${session.username} edited map ${record.filename}`);
                return withCors(json({ updated }), config, req);
            }
            // POST /admin/maps/{id}/visible?visible=0|1 — moderation.
            if (req.method === "POST" && parts.length === 4 && parts[3] === "visible") {
                const visible = new URL(req.url).searchParams.get("visible") === "1";
                const record = resolveAdminMap(deps.maps, parts[2]);
                if (!record) {
                    return deny(config, req, "Map not found", 404);
                }
                deps.maps.setVisible(record.sha256, visible);
                log.info(`admin: ${session.username} set ${record.filename} visible=${visible}`);
                return withCors(json({ visible }), config, req);
            }
            // DELETE /admin/maps/{id} — remove record + blob.
            if (req.method === "DELETE" && parts.length === 3) {
                const record = resolveAdminMap(deps.maps, parts[2]);
                if (!record) {
                    return deny(config, req, "Map not found", 404);
                }
                deps.maps.delete(record.sha256);
                log.info(`admin: ${session.username} deleted map ${record.filename}`);
                return withCors(json({ deleted: true }), config, req);
            }
            return deny(config, req, "Not Found", 404);
        }
        default:
            return deny(config, req, "Not Found", 404);
    }
}

function resolveAdminMap(maps: MapStore, id: string) {
    if (/^[0-9a-f]{64}$/.test(id)) {
        return maps.getBySha256(id);
    }
    return maps.getByFilename(id, true);
}

function requireAdmin(deps: AdminDeps, config: ServerConfig, req: Request, log: Logger): Session | undefined {
    const authorization = req.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const session = deps.sessions.validate(token);
    if (!session) {
        log.warn(`admin: unauthenticated request to ${new URL(req.url).pathname}`);
        return undefined;
    }
    if (!config.adminUsernames.includes(session.username.toLowerCase())) {
        log.warn(`admin: "${session.username}" is not an admin`);
        return undefined;
    }
    return session;
}

function deny(config: ServerConfig, req: Request, message: string, status: number): Response {
    return withCors(json({ error: message }, status), config, req);
}

function httpUrlOf(config: ServerConfig): string {
    return config.externalUrl.replace(/^wss/, "https").replace(/^ws/, "http");
}

// Scans the replay folder for .rpl files, parsing the embedded gameId from
// the "game-<gameId> <timestamp>.rpl" naming used by GservReplayRecorder.
function scanReplayFiles(replaysDir: string): { fileName: string; gameId: string; sizeBytes: number; mtimeMs: number }[] {
    let names: string[];
    try {
        names = readdirSync(replaysDir);
    }
    catch {
        return [];
    }
    const files: { fileName: string; gameId: string; sizeBytes: number; mtimeMs: number }[] = [];
    for (const name of names) {
        if (!name.endsWith(".rpl") || !name.startsWith("game-")) {
            continue;
        }
        const gameId = name.slice("game-".length).split(" ")[0];
        if (!gameId) {
            continue;
        }
        try {
            const stats = statSync(path.join(replaysDir, name));
            files.push({ fileName: name, gameId, sizeBytes: stats.size, mtimeMs: stats.mtimeMs });
        }
        catch {
            // Unreadable file; skip.
        }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
