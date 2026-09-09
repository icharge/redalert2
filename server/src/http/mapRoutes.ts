// Map service HTTP adapter. Everything is a thin mapping between the wire
// format and the MapStore domain facade (see mapstore/MapStore.ts), so the
// store could be swapped for a separate service without touching these routes.
//
// Public surface (no auth):
//   GET  /maps                      — list/search/sort maps (+ stats)
//   GET  /maps.pkt                  — live [MultiMaps] INI for the client
//   GET  /maps/{sha256|filename}    — download a map blob (+1 download)
//   GET  /maps/{id}/meta            — metadata, stats, upload log
//   GET  /maps/stats                — aggregate counts
//
// Authenticated (WOL session bearer token):
//   POST /maps/upload?name=<file>   — upload a map (raw body; sha256 dedup)
//   POST /maps/{id}/rate            — rate 1..5 stars
//
// Game-time transfer (the legacy mapTransferUrl protocol, keyed by gameId;
// host PUTs, guests GET):
//   PUT  /maptransfer/{gameId}      — ingest a map as source='transfer'
//   GET  /maptransfer/{gameId}      — fetch it back

import { ServerConfig } from "../config";
import { SessionManager, Session } from "../auth/session";
import { MapStore } from "../mapstore/MapStore";
import { Logger } from "../logger";
import { withCors } from "./cors";

export interface MapDeps {
    sessions: SessionManager;
    maps: MapStore;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function authenticate(req: Request, sessions: SessionManager): Session | null {
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
        return null;
    }
    return sessions.validate(token) ?? null;
}

const SORT_VALUES = new Set(["newest", "downloads", "uploads", "plays", "rating"]);

export async function handleMaps(req: Request, deps: MapDeps, config: ServerConfig, parts: string[], log: Logger): Promise<Response> {
    const session = authenticate(req, deps.sessions);
    // parts[0] === "maps"
    if (parts.length === 1 && req.method === "GET") {
        const url = new URL(req.url);
        const query = url.searchParams.get("q")?.trim() || undefined;
        const sortRaw = url.searchParams.get("sort") ?? "newest";
        const sort = SORT_VALUES.has(sortRaw) ? sortRaw : "newest";
        const page = Number(url.searchParams.get("page") ?? 1);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const result = deps.maps.list({ query, sort: sort as never, page, limit });
        return withCors(json(result), config, req);
    }

    if (parts.length === 2 && parts[1] === "upload" && req.method === "POST") {
        if (!session) {
            return withCors(json({ error: "Unauthorized" }, 401), config, req);
        }
        const url = new URL(req.url);
        const name = url.searchParams.get("name")?.trim() || undefined;
        const bytes = new Uint8Array(await req.arrayBuffer());
        try {
            const { record, deduplicated } = deps.maps.ingest(bytes, {
                filename: name || "upload.map",
                username: session.username,
                source: "upload",
                visible: config.mapPublishDefault,
            });
            log.info(`map upload: ${record.filename} (${record.sha256.slice(0, 12)}\u2026) by ${session.username}${deduplicated ? " [dedup]" : ""}`);
            return withCors(json({ ...record, deduplicated }), config, req);
        }
        catch (error) {
            log.warn(`map upload rejected for ${session.username}: ${String((error as Error).message)}`);
            return withCors(json({ error: String((error as Error).message) }, 400), config, req);
        }
    }

    if (parts.length === 2 && parts[1] === "pkt" && req.method === "GET") {
        return withCors(new Response(renderPkt(deps.maps), {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-cache",
            },
        }), config, req);
    }

    if (parts.length === 2 && parts[1] === "stats" && req.method === "GET") {
        const counts = deps.maps.counts();
        return withCors(json(counts), config, req);
    }

    if (parts.length === 2 && req.method === "GET") {
        const record = resolveMap(deps.maps, parts[1]);
        if (!record) {
            return withCors(json({ error: "Map not found" }, 404), config, req);
        }
        try {
            const bytes = deps.maps.readBlob(record);
            deps.maps.countDownload(record);
            return withCors(new Response(bytes, {
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(bytes.byteLength),
                    "Cache-Control": "public, max-age=31536000, immutable",
                },
            }), config, req);
        }
        catch (error) {
            log.warn(`map blob read failed for ${record.filename}: ${String((error as Error).message)}`);
            return withCors(json({ error: String((error as Error).message) }, 500), config, req);
        }
    }

    // /maps/{id}/meta | /maps/{id}/rate
    if (parts.length === 3 && req.method === "GET" && parts[2] === "meta") {
        const record = resolveMap(deps.maps, parts[1]);
        if (!record) {
            return withCors(json({ error: "Map not found" }, 404), config, req);
        }
        return withCors(json({
            ...record,
            uploadLog: deps.maps.getUploadLog(record.sha256),
            userRating: session ? deps.maps.getUserRating(record.sha256, session.username) : undefined,
        }), config, req);
    }

    if (parts.length === 3 && req.method === "POST" && parts[2] === "rate") {
        if (!session) {
            return withCors(json({ error: "Unauthorized" }, 401), config, req);
        }
        let body: any;
        try {
            body = await req.json();
        }
        catch {
            return withCors(json({ error: "Invalid request body" }, 400), config, req);
        }
        try {
            const stats = deps.maps.rate(parts[1], session.username, Number(body?.stars));
            return withCors(json({ ratingAvg: stats.avg, ratingCount: stats.count }), config, req);
        }
        catch (error) {
            return withCors(json({ error: String((error as Error).message) }, 400), config, req);
        }
    }

    return withCors(json({ error: "Not Found" }, 404), config, req);
}

export async function handleMapTransfer(req: Request, deps: MapDeps, config: ServerConfig, parts: string[], log: Logger): Promise<Response> {
    const session = authenticate(req, deps.sessions);
    if (!session) {
        return withCors(json({ error: "Unauthorized" }, 401), config, req);
    }
    // parts[0] === "maptransfer"
    if (parts.length !== 2 || !parts[1]) {
        return withCors(json({ error: "Not Found" }, 404), config, req);
    }
    const gameId = parts[1];
    if (req.method === "PUT") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        try {
            const { record } = deps.maps.ingest(bytes, {
                filename: gameId + ".map",
                username: session.username,
                source: "transfer",
                visible: config.mapPublishDefault,
            });
            deps.maps.attachTransfer(gameId, record.sha256, session.username);
            log.info(`map transfer: game ${gameId} <- ${record.filename} (${record.sha256.slice(0, 12)}…) by ${session.username}`);
            return withCors(json({ sha256: record.sha256, size: record.sizeBytes }), config, req);
        }
        catch (error) {
            log.warn(`map transfer upload rejected for ${session.username}: ${String((error as Error).message)}`);
            return withCors(json({ error: String((error as Error).message) }, 400), config, req);
        }
    }
    if (req.method === "GET") {
        const record = deps.maps.getByGameId(gameId);
        if (!record) {
            return withCors(json({ error: "Map not found" }, 404), config, req);
        }
        try {
            const bytes = deps.maps.readBlob(record);
            deps.maps.countDownload(record);
            return withCors(new Response(bytes, {
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(bytes.byteLength),
                },
            }), config, req);
        }
        catch (error) {
            log.warn(`map transfer read failed for game ${gameId}: ${String((error as Error).message)}`);
            return withCors(json({ error: String((error as Error).message) }, 500), config, req);
        }
    }
    return withCors(json({ error: "Not Found" }, 404), config, req);
}

function resolveMap(maps: MapStore, id: string): ReturnType<MapStore["getBySha256"]> {
    if (/^[0-9a-f]{64}$/.test(id)) {
        return maps.getBySha256(id);
    }
    return maps.getByFilename(id);
}

/** Renders the live [MultiMaps] INI the client's MapList consumes.
 * Section keys are derived from the filename stem so the client can look
 * up a section by name without knowing the server-side sha256.
 */
export function renderPkt(maps: MapStore): string {
    const { items } = maps.list({ includeHidden: false, sort: "newest", limit: 5000 });
    const lines: string[] = ["[MultiMaps]"];
    items.forEach((map, index) => {
        const key = filenameStem(map.filename);
        lines.push(`${index + 1}=${key}`);
    });
    lines.push("");
    for (const map of items) {
        const key = filenameStem(map.filename);
        lines.push(`[${key}]`);
        lines.push(`File=${map.filename}`);
        lines.push(`Description=${map.title || map.filename}`);
        if (map.maxPlayers > 0) {
            lines.push(`MaxPlayers=${map.maxPlayers}`);
        }
        const modes = map.gameModes.length ? map.gameModes : ["standard"];
        lines.push(`GameMode=${modes.join(", ")}`);
        lines.push("");
    }
    return lines.join("\n");
}

/** Returns the base name without extension, used as the .pkt section key. */
function filenameStem(filename: string): string {
    const base = filename.split("/").pop()?.split("\\").pop() ?? filename;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}
