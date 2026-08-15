import { Storage } from "../storage/Storage";
import { randomHex } from "../util/random";

export interface Session {
    token: string;
    username: string;
    createdAt: number;
}

export class SessionManager {
    constructor(
        private storage: Storage,
        private ttlSeconds: number,
    ) {
    }

    create(username: string): string {
        this.storage.deleteSessionsByUser(username);
        const token = randomHex(32);
        this.storage.insertSession(token, username, Date.now());
        return token;
    }

    validate(token: string | undefined): Session | undefined {
        if (!token) {
            return undefined;
        }
        const session = this.storage.getSession(token);
        if (!session) {
            return undefined;
        }
        if (Date.now() - session.createdAt > this.ttlSeconds * 1000) {
            this.storage.deleteSession(token);
            return undefined;
        }
        return session;
    }

    revoke(token: string): void {
        this.storage.deleteSession(token);
    }

    revokeByUser(username: string): void {
        this.storage.deleteSessionsByUser(username);
    }

    size(): number {
        return this.storage.countSessions();
    }
}
