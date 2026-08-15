import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function openDatabase(dbPath: string): Database {
    if (dbPath !== ":memory:") {
        mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    // NORMAL (with WAL) avoids the per-commit fsync stall; only the last commit
    // may be lost on OS crash. Sessions are revocable, so this is acceptable.
    db.exec("PRAGMA synchronous = NORMAL");
    return db;
}
