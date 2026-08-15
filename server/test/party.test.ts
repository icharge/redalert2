import { describe, expect, test } from "bun:test";
import { WolServer } from "../src/server/WolServer";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { GservManager } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { FakeSocket, hasLine, makeTestStorage } from "./helpers";

function makeServer() {
    const config = loadConfig({});
    const accounts = new AccountStore(makeTestStorage(), config);
    const sessions = new SessionManager(makeTestStorage(), config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const server = new WolServer(config, sessions, accounts, gservs);
    return { config, accounts, sessions, server };
}

async function login(server: WolServer, accounts: AccountStore, sessions: SessionManager, username: string) {
    await accounts.register(username, "password123");
    const socket = new FakeSocket();
    const user = server.handleOpen(socket);
    server.handleMessage(user, `session ${sessions.create(username)}`);
    user.fresh = false;
    return { socket, user };
}

describe("PartyManager", () => {
    test("invite -> accept forms a party with PARTY_UPDATE", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        alice.user.fresh = false;

        alice.socket.sent.length = 0;
        bob.socket.sent.length = 0;
        server.handleMessage(alice.user, "PARTY_INVITE bob");
        expect(hasLine(bob.socket, line => line.endsWith(":PARTY_INVITE alice"))).toBe(true);
        expect(hasLine(alice.socket, line => line.endsWith(":PARTY_INVITE_SENT bob"))).toBe(true);

        bob.socket.sent.length = 0;
        server.handleMessage(bob.user, "PARTY_ACCEPT alice");
        expect(hasLine(alice.socket, line => line.endsWith(":PARTY_FORMED bob"))).toBe(true);
        expect(hasLine(bob.socket, line => line.endsWith(":PARTY_FORMED alice"))).toBe(true);
        expect(hasLine(alice.socket, line => /:PARTY_UPDATE party-\S+ alice,bob idle 0 0$/.test(line))).toBe(true);
        expect(alice.user.partyId).toBeDefined();
        expect(bob.user.partyId).toBe(alice.user.partyId);
    });

    test("inviting a party member reports TARGET_IN_PARTY", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        const carol = await login(server, accounts, sessions, "carol");
        alice.user.fresh = false;
        server.handleMessage(alice.user, "PARTY_INVITE bob");
        server.handleMessage(bob.user, "PARTY_ACCEPT alice");

        carol.socket.sent.length = 0;
        server.handleMessage(carol.user, "PARTY_INVITE bob");
        expect(hasLine(carol.socket, line => line.endsWith(":PARTY_INVITE_ERROR TARGET_IN_PARTY bob"))).toBe(true);
    });

    test("decline notifies the inviter", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        alice.user.fresh = false;
        server.handleMessage(alice.user, "PARTY_INVITE bob");
        alice.socket.sent.length = 0;
        server.handleMessage(bob.user, "PARTY_DECLINE alice");
        expect(hasLine(alice.socket, line => line.endsWith(":PARTY_INVITE_DECLINED bob"))).toBe(true);
    });

    test("leave disbands the party and reports PARTY_LEFT", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        alice.user.fresh = false;
        server.handleMessage(alice.user, "PARTY_INVITE bob");
        server.handleMessage(bob.user, "PARTY_ACCEPT alice");
        bob.socket.sent.length = 0;
        server.handleMessage(bob.user, "PARTY_LEAVE");
        expect(hasLine(alice.socket, line => line.endsWith(":PARTY_LEFT bob"))).toBe(true);
        expect(alice.user.partyId).toBeUndefined();
        expect(server.parties.getParty(alice.user)).toBeUndefined();
    });

    test("prevented invitations are rejected", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        alice.user.fresh = false;
        server.handleMessage(bob.user, "PARTY_PREVENT alice 1");
        expect(hasLine(bob.socket, line => line.endsWith(":PARTY_INVITE_PREVENTION alice 1"))).toBe(true);
        alice.socket.sent.length = 0;
        server.handleMessage(alice.user, "PARTY_INVITE bob");
        expect(hasLine(alice.socket, line => line.endsWith(":PARTY_INVITE_ERROR INVITE_PREVENTED bob"))).toBe(true);
    });

    test("no-invites users reject invitations", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        alice.user.fresh = false;
        server.handleMessage(bob.user, "PARTY_NOINVITES 1");
        server.handleMessage(alice.user, "PARTY_INVITE bob");
        expect(hasLine(alice.socket, line => line.endsWith(":PARTY_INVITE_ERROR TARGET_NO_INVITES bob"))).toBe(true);
    });

    test("fresh accounts cannot invite", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        alice.user.fresh = true;
        server.handleMessage(alice.user, "PARTY_INVITE bob");
        expect(hasLine(alice.socket, line => line.endsWith(":PARTY_INVITE_ERROR INVITER_FRESH_ACCOUNT bob"))).toBe(true);
    });
});
