import { AccountRecord, SessionRecord, Storage } from "./Storage";

export class MemoryStorage implements Storage {
    private accounts = new Map<string, AccountRecord>();
    private sessions = new Map<string, SessionRecord>();

    accountExists(username: string): boolean {
        return this.accounts.has(username.toLowerCase());
    }

    createAccount(username: string, passwordHash: string, createdAt: number): void {
        this.accounts.set(username.toLowerCase(), { username, passwordHash, createdAt, banned: false });
    }

    getAccount(username: string): AccountRecord | undefined {
        return this.accounts.get(username.toLowerCase());
    }

    countAccounts(): number {
        return this.accounts.size;
    }

    insertSession(token: string, username: string, createdAt: number): void {
        this.sessions.set(token, { token, username, createdAt });
    }

    getSession(token: string): SessionRecord | undefined {
        return this.sessions.get(token);
    }

    deleteSession(token: string): void {
        this.sessions.delete(token);
    }

    deleteSessionsByUser(username: string): void {
        for (const [token, session] of this.sessions) {
            if (session.username === username) {
                this.sessions.delete(token);
            }
        }
    }

    countSessions(): number {
        return this.sessions.size;
    }

    close(): void {
        this.accounts.clear();
        this.sessions.clear();
    }
}
