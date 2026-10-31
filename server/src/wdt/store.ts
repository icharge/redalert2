// Persistence for the World Domination cycle. The whole cycle is small (one
// current map, one frozen previous map, conflicts and history), so it is kept
// as one JSON document: easier to evolve than a dozen tables, and the same
// shape the service already exposes through /wdt/status.

import { Database } from "bun:sqlite";
import { openDatabase } from "../auth/db";
import { WdtCycle } from "./types";

export interface WdtSnapshot {
    version: 1;
    enabled: boolean;
    nextConflict: number;
    nextCycle: number;
    current: WdtCycle;
    previous?: WdtCycle;
}

export interface WdtStore {
    load(): WdtSnapshot | undefined;
    save(snapshot: WdtSnapshot): void;
    close?(): void;
}

export class MemoryWdtStore implements WdtStore {
    private snapshot?: WdtSnapshot;

    load(): WdtSnapshot | undefined {
        return this.snapshot ? JSON.parse(JSON.stringify(this.snapshot)) : undefined;
    }

    save(snapshot: WdtSnapshot): void {
        this.snapshot = JSON.parse(JSON.stringify(snapshot));
    }
}

export class SqliteWdtStore implements WdtStore {
    constructor(private readonly db: Database) {
        db.exec(`CREATE TABLE IF NOT EXISTS wdt_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            document TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )`);
    }

    load(): WdtSnapshot | undefined {
        const row = this.db.query("SELECT document FROM wdt_state WHERE id = 1").get() as { document: string } | null;
        if (!row) return undefined;
        const parsed = JSON.parse(row.document) as WdtSnapshot;
        return parsed.version === 1 ? parsed : undefined;
    }

    save(snapshot: WdtSnapshot): void {
        this.db.query(`INSERT INTO wdt_state (id, document, updated_at) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at`)
            .run(JSON.stringify(snapshot), Date.now());
    }

    close(): void {
        this.db.close();
    }
}

export interface WdtStoreConfig {
    storageEngine: "sqlite" | "memory";
    dbPath: string;
}

/** Use the same database as the rest of the server in sqlite mode; keep a
 * process-only store when the deployment explicitly runs memory storage. */
export function createWdtStore(config: WdtStoreConfig): WdtStore {
    if (config.storageEngine !== "sqlite") return new MemoryWdtStore();
    return new SqliteWdtStore(openDatabase(config.dbPath));
}
