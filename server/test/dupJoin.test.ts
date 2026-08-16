import { describe, expect, test } from "bun:test";
import { WolServer } from "../src/server/WolServer";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { GservManager } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { FakeSocket, hasLine, makeTestStorage } from "./helpers";
import { escapeChannelName } from "../src/protocol/lineCodec";

function make() {
    const config = loadConfig({});
    const accounts = new AccountStore(makeTestStorage(), config);
    const sessions = new SessionManager(makeTestStorage(), config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const server = new WolServer(config, sessions, accounts, gservs);
    return { server, accounts, sessions };
}

async function login(server: WolServer, accounts: AccountStore, sessions: SessionManager, name: string) {
    await accounts.register(name, "password123");
    const socket = new FakeSocket();
    const user = server.handleOpen(socket);
    server.handleMessage(user, `session ${sessions.create(name)}`);
    user.fresh = false;
    return { socket, user };
}

describe("duplicate join", () => {
    test("a second join of the same channel answers the client instead of timing out", async () => {
        const { server, accounts, sessions } = make();
        const { socket, user } = await login(server, accounts, sessions, "alice");
        const key = escapeChannelName("#Lob 50 0");
        server.handleMessage(user, `join ${key} zotclot9`);
        expect(hasLine(socket, line => /JOIN :[^ ]+ #Lob_50_0$/.test(line))).toBe(true);

        socket.sent.length = 0;
        server.handleMessage(user, `join ${key} zotclot9`);
        expect(hasLine(socket, line => /JOIN :[^ ]+ #Lob_50_0$/.test(line))).toBe(true);
        // No duplicate NAMES broadcast.
        expect(hasLine(socket, line => line.includes(" 353 "))).toBe(false);
    });
});
