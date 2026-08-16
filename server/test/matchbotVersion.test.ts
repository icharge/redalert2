import { describe, expect, test } from "bun:test";
import { WolServer } from "../src/server/WolServer";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { GservManager } from "../src/gserv/GservManager";
import { loadConfig, ServerConfig } from "../src/config";
import { escapeChannelName } from "../src/protocol/lineCodec";
import { FakeSocket, hasLine, makeTestStorage } from "./helpers";
import { RPL_BAD_VERS, RPL_WORKING, TAG_COUNTRY, TAG_COLOR, TAG_VERSION, TAG_MODHASH, TAG_RANKED } from "../src/protocol/qmCodes";

function makeServer(gameVersion = "0.83.4"): { config: ServerConfig; server: WolServer; accounts: AccountStore; sessions: SessionManager } {
    const config = loadConfig({ GAME_VERSION: gameVersion });
    const accounts = new AccountStore(makeTestStorage(), config);
    const sessions = new SessionManager(makeTestStorage(), config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const server = new WolServer(config, sessions, accounts, gservs);
    return { config, server, accounts, sessions };
}

async function queue(server: WolServer, accounts: AccountStore, sessions: SessionManager, username: string, version: string, ranked: boolean): Promise<FakeSocket> {
    await accounts.register(username, "password123");
    const token = sessions.create(username);
    const socket = new FakeSocket();
    const user = server.handleOpen(socket);
    server.handleMessage(user, `session ${token}`);
    user.fresh = false;
    // The client joins the quick-match channel of its queue type first.
    server.handleMessage(user, `join ${escapeChannelName("#Lob 50 0")} zotclot9`);
    const request = [
        TAG_COUNTRY + "=0",
        TAG_COLOR + "=0",
        TAG_VERSION + "=" + version,
        TAG_MODHASH + "=deadbeef",
        TAG_RANKED + "=" + Number(ranked),
    ].join(", ");
    server.handleMessage(user, `PRIVMSG matchbot :Match ${request}`);
    return socket;
}

describe("matchbot ranked version gate", () => {
    test("ranked queue rejects a mismatched patch", async () => {
        const { server, accounts, sessions } = makeServer("0.83.4");
        const socket = await queue(server, accounts, sessions, "alice", "0.83.2-abc123", true);
        expect(hasLine(socket, line => line.includes(RPL_BAD_VERS))).toBe(true);
        expect(hasLine(socket, line => line.includes(RPL_WORKING))).toBe(false);
    });

    test("ranked queue accepts the exact patch with any build hash", async () => {
        const { server, accounts, sessions } = makeServer("0.83.4");
        const socket = await queue(server, accounts, sessions, "alice", "0.83.4-abc123", true);
        expect(hasLine(socket, line => line.includes(RPL_WORKING))).toBe(true);
        expect(hasLine(socket, line => line.includes(RPL_BAD_VERS))).toBe(false);
    });

    test("ranked queue rejects a version without a patch", async () => {
        const { server, accounts, sessions } = makeServer("0.83.4");
        const socket = await queue(server, accounts, sessions, "alice", "0.83", true);
        expect(hasLine(socket, line => line.includes(RPL_BAD_VERS))).toBe(true);
    });

    test("ranked queue rejects a newer patch than the server", async () => {
        const { server, accounts, sessions } = makeServer("0.83.2");
        const socket = await queue(server, accounts, sessions, "alice", "0.83.4-abc123", true);
        expect(hasLine(socket, line => line.includes(RPL_BAD_VERS))).toBe(true);
    });

    test("unranked queue still accepts any patch on the same major.minor", async () => {
        const { server, accounts, sessions } = makeServer("0.83.2");
        const socket = await queue(server, accounts, sessions, "alice", "0.83.4-abc123", false);
        expect(hasLine(socket, line => line.includes(RPL_WORKING))).toBe(true);
        expect(hasLine(socket, line => line.includes(RPL_BAD_VERS))).toBe(false);
    });

    test("unranked queue rejects a different major.minor", async () => {
        const { server, accounts, sessions } = makeServer("0.83.2");
        const socket = await queue(server, accounts, sessions, "alice", "0.84.0-abc123", false);
        expect(hasLine(socket, line => line.includes(RPL_BAD_VERS))).toBe(true);
    });
});
