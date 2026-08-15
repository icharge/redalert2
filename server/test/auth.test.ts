import { describe, expect, test } from "bun:test";
import { SessionManager } from "../src/auth/session";
import { AccountStore } from "../src/auth/accountStore";
import { loadConfig } from "../src/config";

const limits = {
    minUsernameLength: 2,
    maxUsernameLength: 15,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    freshAccountAgeSeconds: 3600,
};

describe("SessionManager", () => {
    test("creates and validates a session", () => {
        const sessions = new SessionManager(3600);
        const token = sessions.create("alice");
        const session = sessions.validate(token);
        expect(session?.username).toBe("alice");
    });

    test("rejects unknown or revoked tokens", () => {
        const sessions = new SessionManager(3600);
        const token = sessions.create("alice");
        sessions.revoke(token);
        expect(sessions.validate(token)).toBeUndefined();
        expect(sessions.validate("nope")).toBeUndefined();
    });

    test("expires old sessions", () => {
        const sessions = new SessionManager(1);
        const token = sessions.create("alice");
        sessions.validate(token);
        (sessions as any).sessions.get(token)!.createdAt = Date.now() - 2000;
        expect(sessions.validate(token)).toBeUndefined();
    });

    test("recreating a session invalidates the previous one", () => {
        const sessions = new SessionManager(3600);
        const first = sessions.create("alice");
        const second = sessions.create("alice");
        expect(first).not.toBe(second);
        expect(sessions.validate(first)).toBeUndefined();
        expect(sessions.validate(second)?.username).toBe("alice");
    });
});

describe("AccountStore", () => {
    test("registers and verifies", async () => {
        const store = new AccountStore(limits);
        await store.register("alice", "password123");
        const account = await store.verify("alice", "password123");
        expect(account?.username).toBe("alice");
        expect(await store.verify("alice", "wrong")).toBeUndefined();
        expect(await store.verify("bob", "password123")).toBeUndefined();
    });

    test("rejects duplicate usernames", async () => {
        const store = new AccountStore(limits);
        await store.register("alice", "password123");
        await expect(store.register("Alice", "password123")).rejects.toThrow("username_taken");
    });

    test("enforces username and password limits", async () => {
        const store = new AccountStore(limits);
        await expect(store.register("a", "password123")).rejects.toThrow("bad_username");
        await expect(store.register("alice", "short")).rejects.toThrow("bad_password");
    });

    test("isFresh reflects account age", async () => {
        const store = new AccountStore(limits);
        const account = await store.register("alice", "password123");
        expect(store.isFresh(account)).toBe(true);
        (account as any).createdAt = Date.now() - 2 * 3600 * 1000;
        expect(store.isFresh(account)).toBe(false);
    });
});

test("loadConfig applies defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(9090);
    expect(config.globalChannelPass).toBe("zotclot9");
    expect(config.matchBotName).toBe("matchbot");
});
