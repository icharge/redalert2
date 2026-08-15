import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/auth/session";
import { AccountStore } from "../src/auth/accountStore";
import { createStorage } from "../src/storage";
import { loadConfig } from "../src/config";

const limits = {
    minUsernameLength: 2,
    maxUsernameLength: 15,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    freshAccountAgeSeconds: 3600,
};

function memStorage() {
    return createStorage({ storageEngine: "memory", dbPath: ":memory:" });
}

describe("SessionManager", () => {
    test("creates and validates a session", () => {
        const sessions = new SessionManager(memStorage(), 3600);
        const token = sessions.create("alice");
        const session = sessions.validate(token);
        expect(session?.username).toBe("alice");
    });

    test("rejects unknown or revoked tokens", () => {
        const sessions = new SessionManager(memStorage(), 3600);
        const token = sessions.create("alice");
        sessions.revoke(token);
        expect(sessions.validate(token)).toBeUndefined();
        expect(sessions.validate("nope")).toBeUndefined();
    });

    test("expires old sessions", () => {
        const storage = memStorage();
        const sessions = new SessionManager(storage, -1);
        const token = sessions.create("alice");
        expect(sessions.validate(token)).toBeUndefined();
        expect(storage.countSessions()).toBe(0);
    });

    test("recreating a session invalidates the previous one", () => {
        const sessions = new SessionManager(memStorage(), 3600);
        const first = sessions.create("alice");
        const second = sessions.create("alice");
        expect(first).not.toBe(second);
        expect(sessions.validate(first)).toBeUndefined();
        expect(sessions.validate(second)?.username).toBe("alice");
    });
});

describe("AccountStore", () => {
    test("registers and verifies", async () => {
        const store = new AccountStore(memStorage(), limits);
        await store.register("alice", "password123");
        const account = await store.verify("alice", "password123");
        expect(account?.username).toBe("alice");
        expect(await store.verify("alice", "wrong")).toBeUndefined();
        expect(await store.verify("bob", "password123")).toBeUndefined();
    });

    test("rejects duplicate usernames", async () => {
        const store = new AccountStore(memStorage(), limits);
        await store.register("alice", "password123");
        await expect(store.register("Alice", "password123")).rejects.toThrow("username_taken");
    });

    test("enforces username and password limits", async () => {
        const store = new AccountStore(memStorage(), limits);
        await expect(store.register("a", "password123")).rejects.toThrow("bad_username");
        await expect(store.register("alice", "short")).rejects.toThrow("bad_password");
    });

    test("isFresh reflects account age", async () => {
        const store = new AccountStore(memStorage(), limits);
        const account = await store.register("alice", "password123");
        expect(store.isFresh(account)).toBe(true);
        account.createdAt = Date.now() - 2 * 3600 * 1000;
        expect(store.isFresh(account)).toBe(false);
    });
});

describe("storage engines", () => {
    test("memory and sqlite behave identically", async () => {
        const memStore = new AccountStore(createStorage({ storageEngine: "memory", dbPath: ":memory:" }), limits);
        const sqlStore = new AccountStore(createStorage({ storageEngine: "sqlite", dbPath: ":memory:" }), limits);
        await memStore.register("alice", "password123");
        await sqlStore.register("alice", "password123");
        expect(await memStore.verify("alice", "password123")).toBeTruthy();
        expect(await sqlStore.verify("alice", "password123")).toBeTruthy();
    });

    test("sqlite persists across instances", async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "ra2web-test-"));
        const dbPath = path.join(dir, "test.sqlite");
        try {
            const storage1 = createStorage({ storageEngine: "sqlite", dbPath });
            const first = new AccountStore(storage1, limits);
            await first.register("alice", "password123");
            storage1.close();

            const storage2 = createStorage({ storageEngine: "sqlite", dbPath });
            const second = new AccountStore(storage2, limits);
            expect((await second.verify("alice", "password123"))?.username).toBe("alice");
            storage2.close();
        }
        finally {
            try {
                rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // best-effort cleanup (Windows may briefly hold the file)
            }
        }
    });

    test("createStorage rejects unknown engines", () => {
        expect(() => createStorage({ storageEngine: "bogus" as any, dbPath: ":memory:" })).toThrow("Unknown storage engine");
    });
});

test("loadConfig applies defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(9090);
    expect(config.globalChannelPass).toBe("zotclot9");
    expect(config.matchBotName).toBe("matchbot");
    expect(config.storageEngine).toBe("sqlite");
});

test("loadConfig splits SERVER_MOTD on newlines", () => {
    const config = loadConfig({ SERVER_MOTD: "line one\\nline two" });
    expect(config.motd).toEqual(["line one", "line two"]);
    expect(config.motd.length).toBe(2);
});
