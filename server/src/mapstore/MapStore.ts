// Map service domain: content-addressed map storage, metadata, statistics and
// ratings, plus an append-only upload log (who uploaded what, and via which
// path). Blobs are stored once on disk under mapsDir/{sha256}; every reference
// to the same bytes (re-upload, game-time transfer) deduplicates onto the same
// row and bumps counters instead of duplicating storage.
//
// The store deliberately lives behind one facade so the whole feature could be
// extracted into its own service/DB without touching route handlers.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../auth/db";

export type MapSource = "upload" | "transfer" | "seed";

export interface MapMetadata {
    title: string;
    description: string;
    official: boolean;
    maxPlayers: number;
    /** Comma-separated mode filters as understood by the client's GameModes. */
    gameModes: string[];
    theater: string;
}

export interface MapRecord extends MapMetadata {
    sha256: string;
    filename: string;
    sizeBytes: number;
    uploader: string;
    source: MapSource;
    visible: boolean;
    downloads: number;
    uploads: number;
    createdAt: number;
}

export interface MapStats {
    plays: number;
    ratingAvg: number;
    ratingCount: number;
}

export interface MapListItem extends MapRecord {
    stats: MapStats;
}

export type MapSort = "newest" | "downloads" | "uploads" | "plays" | "rating";

export interface MapListQuery {
    query?: string;
    sort?: MapSort;
    page?: number;
    limit?: number;
    includeHidden?: boolean;
}

export interface MapListResult {
    items: MapListItem[];
    total: number;
    page: number;
    limit: number;
}

export interface MapStoreOptions {
    mapsDir: string;
    maxUploadBytes: number;
}

interface MapRow {
    sha256: string;
    filename: string;
    size_bytes: number;
    title: string;
    description: string;
    official: number;
    max_players: number;
    game_modes: string;
    theater: string;
    uploader: string;
    source: MapSource;
    visible: number;
    downloads: number;
    uploads: number;
    created_at: number;
    plays: number;
    rating_avg: number | null;
    rating_count: number;
}

const SORT_COLUMNS: Record<MapSort, string> = {
    newest: "m.created_at DESC",
    downloads: "m.downloads DESC, m.created_at DESC",
    uploads: "m.uploads DESC, m.created_at DESC",
    plays: "plays DESC, m.created_at DESC",
    rating: "rating_avg DESC, m.created_at DESC",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class MapStore {
    private db: Database;
    private readonly mapsDir: string;
    private readonly maxUploadBytes: number;
    private readonly playsSql: string;
    private mapUpsert;
    private mapSelectBySha;
    private mapSelectByFilename;
    private mapSelectByFilenameAny;
    private mapUpdateMeta;
    private mapSetVisible;
    private mapIncrementDownloads;
    private mapIncrementUploads;
    private mapDelete;
    private uploadEventInsert;
    private uploadEventSelectBySha;
    private transferUpsert;
    private transferSelectByGameId;
    private transferDeleteBySha;
    private ratingUpsert;
    private ratingSelectBySha;
    private ratingAvgBySha;
    private countAll;
    private countVisible;

    constructor(db: Database, options: MapStoreOptions) {
        this.db = db;
        this.mapsDir = options.mapsDir;
        this.maxUploadBytes = options.maxUploadBytes;
        db.exec(`
            CREATE TABLE IF NOT EXISTS maps (
                sha256 TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                official INTEGER NOT NULL DEFAULT 0,
                max_players INTEGER NOT NULL DEFAULT 0,
                game_modes TEXT NOT NULL DEFAULT '',
                theater TEXT NOT NULL DEFAULT '',
                uploader TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'upload',
                visible INTEGER NOT NULL DEFAULT 1,
                downloads INTEGER NOT NULL DEFAULT 0,
                uploads INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_maps_filename ON maps (filename);
            CREATE INDEX IF NOT EXISTS idx_maps_visible ON maps (visible);
            CREATE TABLE IF NOT EXISTS map_upload_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sha256 TEXT NOT NULL,
                filename TEXT NOT NULL,
                username TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_upload_events_sha ON map_upload_events (sha256, created_at DESC);
            CREATE TABLE IF NOT EXISTS map_ratings (
                sha256 TEXT NOT NULL,
                username_key TEXT NOT NULL,
                stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
                created_at INTEGER NOT NULL,
                PRIMARY KEY (sha256, username_key)
            );
            CREATE TABLE IF NOT EXISTS map_transfers (
                game_id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL,
                username TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_map_transfers_sha ON map_transfers (sha256);
            `);
        const hasLadderMatchPlayers = db.query(`
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ladder_match_players'
        `).get() !== null;
        this.playsSql = hasLadderMatchPlayers
            ? "(SELECT COUNT(DISTINCT game_id) FROM ladder_match_players WHERE lower(map_name) = lower(m.filename))"
            : "0";
        this.mapUpsert = db.prepare(`
            INSERT INTO maps (sha256, filename, size_bytes, title, description, official,
                max_players, game_modes, theater, uploader, source, visible, downloads, uploads, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`);
        this.mapSelectBySha = db.prepare(`
            SELECT m.sha256, m.filename, m.size_bytes, m.title, m.description, m.official,
                m.max_players, m.game_modes, m.theater, m.uploader, m.source, m.visible,
                m.downloads, m.uploads, m.created_at,
                ${this.playsSql} AS plays,
                (SELECT AVG(stars) FROM map_ratings WHERE sha256 = m.sha256) AS rating_avg,
                (SELECT COUNT(*) FROM map_ratings WHERE sha256 = m.sha256) AS rating_count
            FROM maps m WHERE m.sha256 = ?`);
        this.mapSelectByFilename = db.prepare(`
            SELECT m.sha256, m.filename, m.size_bytes, m.title, m.description, m.official,
                m.max_players, m.game_modes, m.theater, m.uploader, m.source, m.visible,
                m.downloads, m.uploads, m.created_at,
                ${this.playsSql} AS plays,
                (SELECT AVG(stars) FROM map_ratings WHERE sha256 = m.sha256) AS rating_avg,
                (SELECT COUNT(*) FROM map_ratings WHERE sha256 = m.sha256) AS rating_count
            FROM maps m WHERE lower(m.filename) = lower(?) AND m.visible = 1`);
        this.mapSelectByFilenameAny = db.prepare(`
            SELECT m.sha256, m.filename, m.size_bytes, m.title, m.description, m.official,
                m.max_players, m.game_modes, m.theater, m.uploader, m.source, m.visible,
                m.downloads, m.uploads, m.created_at,
                ${this.playsSql} AS plays,
                (SELECT AVG(stars) FROM map_ratings WHERE sha256 = m.sha256) AS rating_avg,
                (SELECT COUNT(*) FROM map_ratings WHERE sha256 = m.sha256) AS rating_count
            FROM maps m WHERE lower(m.filename) = lower(?)`);
        this.mapUpdateMeta = db.prepare(`
            UPDATE maps SET title = ?, description = ?, official = ?, max_players = ?, game_modes = ?, theater = ?
            WHERE sha256 = ?`);
        this.mapSetVisible = db.prepare("UPDATE maps SET visible = ? WHERE sha256 = ?");
        this.mapIncrementDownloads = db.prepare("UPDATE maps SET downloads = downloads + 1 WHERE sha256 = ?");
        this.mapIncrementUploads = db.prepare("UPDATE maps SET uploads = uploads + 1 WHERE sha256 = ?");
        this.mapDelete = db.prepare("DELETE FROM maps WHERE sha256 = ?");
        this.uploadEventInsert = db.prepare(`
            INSERT INTO map_upload_events (sha256, filename, username, source, created_at) VALUES (?, ?, ?, ?, ?)`);
        this.uploadEventSelectBySha = db.prepare(`
            SELECT id, sha256, filename, username, source, created_at FROM map_upload_events
            WHERE sha256 = ? ORDER BY created_at DESC LIMIT ?`);
        this.transferUpsert = db.prepare(`
            INSERT INTO map_transfers (game_id, sha256, username, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(game_id) DO UPDATE SET sha256 = excluded.sha256, username = excluded.username, created_at = excluded.created_at`);
        this.transferSelectByGameId = db.prepare("SELECT game_id, sha256, username, created_at FROM map_transfers WHERE game_id = ?");
        this.transferDeleteBySha = db.prepare("DELETE FROM map_transfers WHERE sha256 = ?");
        this.ratingUpsert = db.prepare(`
            INSERT INTO map_ratings (sha256, username_key, stars, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(sha256, username_key) DO UPDATE SET stars = excluded.stars, created_at = excluded.created_at`);
        this.ratingSelectBySha = db.prepare("SELECT sha256, username_key, stars, created_at FROM map_ratings WHERE sha256 = ? AND username_key = ?");
        this.ratingAvgBySha = db.prepare("SELECT AVG(stars) AS avg, COUNT(*) AS count FROM map_ratings WHERE sha256 = ?");
        this.countAll = db.prepare("SELECT COUNT(*) AS count FROM maps");
        this.countVisible = db.prepare("SELECT COUNT(*) AS count FROM maps WHERE visible = 1");
    }

    static create(config: { dbPath: string; mapsDir: string; maxUploadBytes: number }): MapStore {
        return new MapStore(openDatabase(config.dbPath), {
            mapsDir: config.mapsDir,
            maxUploadBytes: config.maxUploadBytes,
        });
    }

    /**
     * Stores (or deduplicates) a map blob. Returns the canonical record and
     * whether the bytes were already known. Every call appends an upload event
     * and bumps the uploads counter — a re-upload of identical bytes is
     * recorded, not rejected, so "who uploaded this map" stays truthful.
     */
    ingest(
        bytes: Uint8Array,
        input: { filename: string; username: string; source: MapSource; visible: boolean },
    ): { record: MapRecord; deduplicated: boolean } {
        if (bytes.byteLength === 0) {
            throw new Error("Empty map file");
        }
        if (bytes.byteLength > this.maxUploadBytes) {
            throw new Error(`Map file exceeds maximum size of ${this.maxUploadBytes} bytes`);
        }
        const sha256 = hashBytes(bytes);
        const now = Date.now();
        const existing = this.getBySha256(sha256);
        const metadata = existing ?? parseMapMetadata(bytes);
        const filename = existing?.filename ?? sanitizeFilename(input.filename);
        if (existing) {
            this.mapIncrementUploads.run(sha256);
            this.uploadEventInsert.run(sha256, filename, input.username, input.source, now);
            return { record: { ...existing, uploads: existing.uploads + 1 }, deduplicated: true };
        }
        mkdirSync(this.mapsDir, { recursive: true });
        const blobPath = this.blobPath(sha256);
        const tmpPath = blobPath + ".tmp-" + now;
        writeFileSync(tmpPath, bytes);
        renameSync(tmpPath, blobPath);
        this.mapUpsert.run(
            sha256,
            filename,
            bytes.byteLength,
            metadata.title,
            metadata.description,
            metadata.official ? 1 : 0,
            metadata.maxPlayers,
            metadata.gameModes.join(","),
            metadata.theater,
            input.username,
            input.source,
            input.visible ? 1 : 0,
            now,
        );
        this.uploadEventInsert.run(sha256, filename, input.username, input.source, now);
        return { record: this.getBySha256(sha256)!, deduplicated: false };
    }

    /**
     * Records a game-time transfer (the legacy mapTransferUrl flow, keyed by
     * gameId). The blob itself lives in the map store; the row only maps
     * gameId → sha256 so guests can fetch it back after the host's upload.
     */
    attachTransfer(gameId: string, sha256: string, username: string): void {
        this.transferUpsert.run(gameId, sha256, username, Date.now());
    }

    getByGameId(gameId: string): MapRecord | undefined {
        const row = this.transferSelectByGameId.get(gameId) as { sha256: string } | null;
        if (!row) {
            return undefined;
        }
        return this.getBySha256(row.sha256);
    }

    getBySha256(sha256: string): MapRecord | undefined {
        const row = this.mapSelectBySha.get(sha256) as MapRow | null;
        return row ? this.mapRowToRecord(row) : undefined;
    }

    getByFilename(filename: string, includeHidden = false): MapRecord | undefined {
        const stmt = includeHidden ? this.mapSelectByFilenameAny : this.mapSelectByFilename;
        const row = stmt.get(filename) as MapRow | null;
        return row ? this.mapRowToRecord(row) : undefined;
    }

    list(query: MapListQuery): MapListResult {
        const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
        const page = Math.max(1, Math.trunc(query.page ?? 1));
        const offset = (page - 1) * limit;
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (!query.includeHidden) {
            where.push("m.visible = 1");
        }
        if (query.query) {
            where.push("(lower(m.filename) LIKE ? OR lower(m.title) LIKE ?)");
            const needle = "%" + query.query.toLowerCase() + "%";
            params.push(needle, needle);
        }
        const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
        const sort = SORT_COLUMNS[query.sort ?? "newest"];
        const rows = this.db.query(`
            SELECT m.sha256, m.filename, m.size_bytes, m.title, m.description, m.official,
                m.max_players, m.game_modes, m.theater, m.uploader, m.source, m.visible,
                m.downloads, m.uploads, m.created_at,
                ${this.playsSql} AS plays,
                (SELECT AVG(stars) FROM map_ratings WHERE sha256 = m.sha256) AS rating_avg,
                (SELECT COUNT(*) FROM map_ratings WHERE sha256 = m.sha256) AS rating_count
            FROM maps m
            ${whereSql}
            ORDER BY ${sort}
            LIMIT ? OFFSET ?`).all(...params, limit, offset) as MapRow[];
        const totalRow = this.db.query(`SELECT COUNT(*) AS count FROM maps m ${whereSql}`).get(...params) as { count: number };
        return {
            items: rows.map(row => ({ ...this.mapRowToRecord(row), stats: mapRowToStats(row) })),
            total: totalRow.count,
            page,
            limit,
        };
    }

    rate(sha256: string, username: string, stars: number): { avg: number; count: number } {
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
            throw new Error("Rating must be an integer between 1 and 5");
        }
        if (!this.getBySha256(sha256)) {
            throw new Error("Map not found");
        }
        this.ratingUpsert.run(sha256, username.toLowerCase(), stars, Date.now());
        return this.ratingStats(sha256);
    }

    ratingStats(sha256: string): { avg: number; count: number } {
        const row = this.ratingAvgBySha.get(sha256) as { avg: number | null; count: number };
        return { avg: row.avg ?? 0, count: row.count };
    }

    getUserRating(sha256: string, username: string): number | undefined {
        const row = this.ratingSelectBySha.get(sha256, username.toLowerCase()) as { stars: number } | null;
        return row?.stars;
    }

    getUploadLog(sha256: string, limit = 20): Array<{ username: string; source: MapSource; createdAt: number }> {
        const rows = this.uploadEventSelectBySha.all(sha256, limit) as Array<{
            username: string;
            source: MapSource;
            created_at: number;
        }>;
        return rows.map(row => ({ username: row.username, source: row.source, createdAt: row.created_at }));
    }

    /** Admin edits. Returns false when the map doesn't exist. */
    updateMeta(sha256: string, meta: Partial<MapMetadata>): boolean {
        const existing = this.getBySha256(sha256);
        if (!existing) {
            return false;
        }
        const next: MapMetadata = {
            title: meta.title ?? existing.title,
            description: meta.description ?? existing.description,
            official: meta.official ?? existing.official,
            maxPlayers: meta.maxPlayers ?? existing.maxPlayers,
            gameModes: meta.gameModes ?? existing.gameModes,
            theater: meta.theater ?? existing.theater,
        };
        this.mapUpdateMeta.run(
            next.title,
            next.description,
            next.official ? 1 : 0,
            next.maxPlayers,
            next.gameModes.join(","),
            next.theater,
            sha256,
        );
        return true;
    }

    setVisible(sha256: string, visible: boolean): boolean {
        return this.mapSetVisible.run(visible ? 1 : 0, sha256).changes > 0;
    }

    /** Removes the record, ratings, transfers and the content-addressed blob. */
    delete(sha256: string): boolean {
        const record = this.getBySha256(sha256);
        if (!record) {
            return false;
        }
        this.db.transaction(() => {
            this.db.query("DELETE FROM map_upload_events WHERE sha256 = ?").run(sha256);
            this.db.query("DELETE FROM map_ratings WHERE sha256 = ?").run(sha256);
            this.transferDeleteBySha.run(sha256);
            this.mapDelete.run(sha256);
        })();
        const blobPath = this.blobPath(sha256);
        if (existsSync(blobPath)) {
            unlinkSync(blobPath);
        }
        return true;
    }

    /** Reads the blob for a record; throws if the file is missing/corrupt. */
    readBlob(record: MapRecord): Uint8Array {
        const blobPath = this.blobPath(record.sha256);
        if (!existsSync(blobPath)) {
            throw new Error(`Blob missing for map ${record.filename}`);
        }
        const bytes = readFileSync(blobPath);
        if (hashBytes(bytes) !== record.sha256) {
            throw new Error(`Blob corrupt for map ${record.filename}`);
        }
        return bytes;
    }

    /** Downloads bump the counter (after a successful read). */
    countDownload(record: MapRecord): void {
        this.mapIncrementDownloads.run(record.sha256);
    }

    counts(): { total: number; visible: number } {
        return {
            total: (this.countAll.get() as { count: number }).count,
            visible: (this.countVisible.get() as { count: number }).count,
        };
    }

    private blobPath(sha256: string): string {
        return path.join(this.mapsDir, sha256);
    }

    private mapRowToRecord = (row: MapRow): MapRecord => ({
        sha256: row.sha256,
        filename: row.filename,
        sizeBytes: row.size_bytes,
        title: row.title,
        description: row.description,
        official: row.official !== 0,
        maxPlayers: row.max_players,
        gameModes: row.game_modes ? row.game_modes.split(",").filter(Boolean) : [],
        theater: row.theater,
        uploader: row.uploader,
        source: row.source,
        visible: row.visible !== 0,
        downloads: row.downloads,
        uploads: row.uploads,
        createdAt: row.created_at,
    });
}

function mapRowToStats(row: MapRow): MapStats {
    return {
        plays: row.plays,
        ratingAvg: roundRating(row.rating_avg),
        ratingCount: row.rating_count,
    };
}

function roundRating(avg: number | null): number {
    if (avg === null) {
        return 0;
    }
    return Math.round(avg * 100) / 100;
}

/**
 * Extracts [Basic]/[Waypoints] metadata from a map file's text — the same
 * sections the game client reads (see src/engine/MapManifest.ts). Unknown
 * maps degrade to filename-based defaults; nothing here ever rejects a map.
 */
export function parseMapMetadata(bytes: Uint8Array): MapMetadata {
    const text = new TextDecoder().decode(bytes);
    const basic = extractIniSection(text, "Basic");
    const waypoints = extractIniSection(text, "Waypoints");
    const read = (section: string | undefined, key: string): string | undefined => {
        if (!section) {
            return undefined;
        }
        const match = section.split(/\r?\n/).find(line => {
            const trimmed = line.trim();
            return trimmed.startsWith(key + "=") || trimmed.startsWith(key + " =");
        });
        return match ? match.split("=").slice(1).join("=").trim() : undefined;
    };
    const name = read(basic, "Name");
    const official = (read(basic, "Official") ?? "").toLowerCase() === "yes";
    const modeRaw = read(basic, "GameMode");
    const gameModes = modeRaw
        ? modeRaw.split(/\s*,\s*/).map(mode => mode.trim()).filter(Boolean)
        : ["standard"];
    let maxPlayers = 0;
    if (waypoints) {
        for (const line of waypoints.split(/\r?\n/)) {
            const trimmed = line.trim();
            const key = trimmed.split(/[=:]/)[0]?.trim();
            if (key !== undefined && /^\d+$/.test(key) && Number(key) < 8) {
                maxPlayers = Math.max(maxPlayers, Number(key) + 1);
            }
        }
    }
    return {
        title: name ?? "",
        description: "",
        official,
        maxPlayers,
        gameModes,
        theater: "",
    };
}

function extractIniSection(text: string, sectionName: string): string | undefined {
    const startTag = `[${sectionName}]`;
    const start = text.indexOf(startTag);
    if (start === -1) {
        return undefined;
    }
    const sectionStart = start + startTag.length;
    const nextSection = text.indexOf("\n[", sectionStart);
    const end = nextSection === -1 ? text.length : nextSection + 1;
    return text.slice(sectionStart, end);
}

function hashBytes(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** Keeps filenames within what the client's VFS/RFS accepts: [A-Za-z0-9._-]. */
function sanitizeFilename(filename: string): string {
    const base = filename.split("/").pop()?.split("\\").pop() ?? filename;
    const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
    return cleaned || "map.map";
}
