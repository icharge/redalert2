export type StorageEngine = "sqlite" | "memory";

export interface AccountRecord {
    username: string;
    passwordHash: string;
    createdAt: number;
    banned: boolean;
}

export interface SessionRecord {
    token: string;
    username: string;
    createdAt: number;
}

/**
 * Pluggable persistence backend for accounts and sessions.
 * Implement a new backend by extending this interface and registering it in
 * `createStorage`. Usernames are matched case-insensitively.
 */
export interface Storage {
    accountExists(username: string): boolean;
    createAccount(username: string, passwordHash: string, createdAt: number): void;
    getAccount(username: string): AccountRecord | undefined;
    countAccounts(): number;
    insertSession(token: string, username: string, createdAt: number): void;
    getSession(token: string): SessionRecord | undefined;
    deleteSession(token: string): void;
    deleteSessionsByUser(username: string): void;
    countSessions(): number;
    close(): void;
}
