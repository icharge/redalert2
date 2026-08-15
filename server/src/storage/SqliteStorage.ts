import { Database } from "bun:sqlite";
import { AccountRecord, SessionRecord, Storage } from "./Storage";

interface AccountRow {
    username: string;
    password_hash: string;
    created_at: number;
    banned: number;
}

interface SessionRow {
    token: string;
    username: string;
    created_at: number;
}

export class SqliteStorage implements Storage {
    private db: Database;
    private accountInsert;
    private accountSelect;
    private accountCount;
    private sessionInsert;
    private sessionSelect;
    private sessionDelete;
    private sessionDeleteByUser;
    private sessionCount;

    constructor(db: Database) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS accounts (
            username_key TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            banned INTEGER NOT NULL DEFAULT 0
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )`);
        this.accountInsert = db.prepare("INSERT INTO accounts (username_key, username, password_hash, created_at, banned) VALUES (?, ?, ?, ?, ?)");
        this.accountSelect = db.prepare("SELECT username, password_hash, created_at, banned FROM accounts WHERE username_key = ?");
        this.accountCount = db.prepare("SELECT COUNT(*) AS count FROM accounts");
        this.sessionInsert = db.prepare("INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)");
        this.sessionSelect = db.prepare("SELECT token, username, created_at FROM sessions WHERE token = ?");
        this.sessionDelete = db.prepare("DELETE FROM sessions WHERE token = ?");
        this.sessionDeleteByUser = db.prepare("DELETE FROM sessions WHERE username = ?");
        this.sessionCount = db.prepare("SELECT COUNT(*) AS count FROM sessions");
    }

    accountExists(username: string): boolean {
        return this.accountSelect.get(username.toLowerCase()) !== null;
    }

    createAccount(username: string, passwordHash: string, createdAt: number): void {
        this.accountInsert.run(username.toLowerCase(), username, passwordHash, createdAt, 0);
    }

    getAccount(username: string): AccountRecord | undefined {
        const row = this.accountSelect.get(username.toLowerCase()) as AccountRow | null;
        return row ? {
            username: row.username,
            passwordHash: row.password_hash,
            createdAt: row.created_at,
            banned: row.banned !== 0,
        } : undefined;
    }

    countAccounts(): number {
        return (this.accountCount.get() as { count: number }).count;
    }

    insertSession(token: string, username: string, createdAt: number): void {
        this.sessionInsert.run(token, username, createdAt);
    }

    getSession(token: string): SessionRecord | undefined {
        const row = this.sessionSelect.get(token) as SessionRow | null;
        return row ? { token: row.token, username: row.username, createdAt: row.created_at } : undefined;
    }

    deleteSession(token: string): void {
        this.sessionDelete.run(token);
    }

    deleteSessionsByUser(username: string): void {
        this.sessionDeleteByUser.run(username);
    }

    countSessions(): number {
        return (this.sessionCount.get() as { count: number }).count;
    }

    close(): void {
        this.db.close();
    }
}
