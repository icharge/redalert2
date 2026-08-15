import { randomHex } from "../util/random";

export interface Session {
    token: string;
    username: string;
    createdAt: number;
}

export class SessionManager {
    private sessions = new Map<string, Session>();

    constructor(private ttlSeconds: number) {
    }

    create(username: string): string {
        this.revokeByUser(username);
        const token = randomHex(32);
        this.sessions.set(token, { token, username, createdAt: Date.now() });
        return token;
    }

    validate(token: string | undefined): Session | undefined {
        if (!token) {
            return undefined;
        }
        const session = this.sessions.get(token);
        if (!session) {
            return undefined;
        }
        if (Date.now() - session.createdAt > this.ttlSeconds * 1000) {
            this.sessions.delete(token);
            return undefined;
        }
        return session;
    }

    revoke(token: string): void {
        this.sessions.delete(token);
    }

    revokeByUser(username: string): void {
        for (const [token, session] of this.sessions) {
            if (session.username === username) {
                this.sessions.delete(token);
            }
        }
    }

    size(): number {
        return this.sessions.size;
    }
}
