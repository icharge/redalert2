import { describe, expect, test } from "bun:test";
import { WolServer } from "../src/server/WolServer";
import { ServerUser } from "../src/server/ServerUser";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { GservManager } from "../src/gserv/GservManager";
import { loadConfig } from "../src/config";
import { escapeChannelName } from "../src/protocol/lineCodec";
import { FakeSocket, hasLine } from "./helpers";

function makeServer() {
    const config = loadConfig({});
    const accounts = new AccountStore(config);
    const sessions = new SessionManager(config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const server = new WolServer(config, sessions, accounts, gservs);
    return { config, accounts, sessions, gservs, server };
}

async function login(server: WolServer, accounts: AccountStore, sessions: SessionManager, username: string): Promise<{ socket: FakeSocket; user: ServerUser; token: string }> {
    await accounts.register(username, "password123");
    const token = sessions.create(username);
    const socket = new FakeSocket();
    const user = server.handleOpen(socket);
    server.handleMessage(user, `session ${token}`);
    user.fresh = false;
    return { socket, user, token };
}

const LOBBY = escapeChannelName("#Lob 45 0");
const GAME_NAME = escapeChannelName("#alice's game");

describe("WolServer login", () => {
    test("authenticates a session and sends the MOTD block", async () => {
        const { server, accounts, sessions } = makeServer();
        const { socket, user } = await login(server, accounts, sessions, "alice");
        expect(user.authenticated).toBe(true);
        expect(user.nick).toBe("alice");
        const lines = socket.lines();
        expect(hasLine(socket, line => line.startsWith(":wol-ra2web 375 alice"))).toBe(true);
        expect(hasLine(socket, line => line.startsWith(":wol-ra2web 372 alice :- "))).toBe(true);
        expect(hasLine(socket, line => line.startsWith(":wol-ra2web 376 alice"))).toBe(true);
        expect(lines[0]).toMatch(/^:wol-ra2web /);
    });

    test("rejects an invalid session token", async () => {
        const { server } = makeServer();
        const socket = new FakeSocket();
        const user = server.handleOpen(socket);
        server.handleMessage(user, "session not-a-token");
        expect(user.authenticated).toBe(false);
        expect(hasLine(socket, line => line.startsWith(":wol-ra2web 378"))).toBe(true);
    });
});

describe("WolServer channels", () => {
    test("join sends own JOIN broadcast and NAMES", async () => {
        const { server, accounts, sessions } = makeServer();
        const { socket, user } = await login(server, accounts, sessions, "alice");
        socket.sent.length = 0;
        server.handleMessage(user, `join ${LOBBY} zotclot9`);
        expect(hasLine(socket, line => /JOIN :\d+,\d+,0,0 #Lob_45_0$/.test(line))).toBe(true);
        expect(hasLine(socket, line => line.startsWith(":wol-ra2web 353 alice = #Lob_45_0 :alice,"))).toBe(true);
        expect(hasLine(socket, line => line.startsWith(":wol-ra2web 366 alice #Lob_45_0"))).toBe(true);
        expect(user.channels.has(LOBBY)).toBe(true);
    });

    test("rejects joining the lobby channel with a bad password", async () => {
        const { server, accounts, sessions } = makeServer();
        const { socket, user } = await login(server, accounts, sessions, "alice");
        socket.sent.length = 0;
        server.handleMessage(user, `join ${LOBBY} wrongpass`);
        expect(hasLine(socket, line => line.startsWith(":wol-ra2web 475 alice"))).toBe(true);
        expect(user.channels.has(LOBBY)).toBe(false);
    });

    test("relays channel chat to other members only", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `join ${LOBBY} zotclot9`);
        server.handleMessage(bob.user, `join ${LOBBY} zotclot9`);
        alice.socket.sent.length = 0;
        bob.socket.sent.length = 0;
        server.handleMessage(alice.user, `privmsg ${LOBBY} :hello bob`);
        expect(hasLine(bob.socket, line => /PRIVMSG #Lob_45_0 :hello bob$/.test(line))).toBe(true);
        expect(hasLine(alice.socket, line => /PRIVMSG #Lob_45_0 :hello bob$/.test(line))).toBe(false);
    });

    test("sends an updated NAMES list to all members after a join", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `join ${LOBBY} zotclot9`);
        alice.socket.sent.length = 0;
        server.handleMessage(bob.user, `join ${LOBBY} zotclot9`);
        expect(hasLine(alice.socket, line => line.includes("353 alice = #Lob_45_0 :alice,0,0,0 bob,0,0,0"))).toBe(true);
    });
});

describe("WolServer games", () => {
    test("create + join + list + gameopt relay + startg", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `join ${LOBBY} zotclot9`);

        alice.socket.sent.length = 0;
        server.handleMessage(alice.user, `joingame ${GAME_NAME} 1 9 45 0 0 0 0`);
        expect(hasLine(alice.socket, line => /JOINGAME [^:]+:#alice's_game$/.test(line))).toBe(true);
        expect(hasLine(alice.socket, line => line.startsWith(":wol-ra2web 353 alice = #alice's_game :@alice,"))).toBe(true);
        expect(hasLine(alice.socket, line => line.startsWith(":wol-ra2web GSERV #alice's_game :gs1 ws://test.local/gserv"))).toBe(true);

        server.handleMessage(bob.user, `joingame ${GAME_NAME} 0`);
        expect(hasLine(bob.socket, line => /JOINGAME [^:]+:#alice's_game$/.test(line))).toBe(true);
        expect(hasLine(alice.socket, line => line.includes("353 alice = #alice's_game :@alice,0,0,0 bob,0,0,0"))).toBe(true);

        alice.socket.sent.length = 0;
        server.handleMessage(alice.user, `topic ${GAME_NAME} :g19N39,0,0,0,0,mpdefault,,,,0.83.2`);
        server.handleMessage(alice.user, `list 45 45`);
        expect(hasLine(alice.socket, line => line.startsWith(":wol-ra2web 321 alice"))).toBe(true);
        expect(hasLine(alice.socket, line => line.includes("322 alice #alice's_game 2 0 0 0 0 0 45::g19N39"))).toBe(true);
        expect(hasLine(alice.socket, line => line.startsWith(":wol-ra2web 323 alice"))).toBe(true);

        alice.socket.sent.length = 0;
        bob.socket.sent.length = 0;
        server.handleMessage(alice.user, `gameopt ${GAME_NAME} :A1`);
        expect(hasLine(bob.socket, line => /GAMEOPT #alice's_game :A1$/.test(line))).toBe(true);
        expect(hasLine(alice.socket, line => /GAMEOPT #alice's_game :A1$/.test(line))).toBe(false);

        alice.socket.sent.length = 0;
        bob.socket.sent.length = 0;
        server.handleMessage(alice.user, `startg ${GAME_NAME} alice,bob`);
        expect(hasLine(alice.socket, line => /^:wol-ra2web STARTG #alice's_game :ws:\/\/test\.local\/gserv :g/.test(line))).toBe(true);
        expect(hasLine(bob.socket, line => /^:wol-ra2web STARTG #alice's_game :ws:\/\/test\.local\/gserv :g/.test(line))).toBe(true);
    });

    test("rejects joining a game with a bad password", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `joingame ${GAME_NAME} 1 9 45 0 0 0 0 secret`);
        bob.socket.sent.length = 0;
        server.handleMessage(bob.user, `joingame ${GAME_NAME} 0 wrong`);
        expect(hasLine(bob.socket, line => line.startsWith(":wol-ra2web 475 bob"))).toBe(true);
    });

    test("rejects startg from a non-host", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `joingame ${GAME_NAME} 1 9 45 0 0 0 0`);
        server.handleMessage(bob.user, `joingame ${GAME_NAME} 0`);
        bob.socket.sent.length = 0;
        server.handleMessage(bob.user, `startg ${GAME_NAME} alice,bob`);
        expect(hasLine(bob.socket, line => line.startsWith(":wol-ra2web 482 bob"))).toBe(true);
    });

    test("aborts startg when a listed player is not in the game", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        server.handleMessage(alice.user, `joingame ${GAME_NAME} 1 9 45 0 0 0 0`);
        alice.socket.sent.length = 0;
        server.handleMessage(alice.user, `startg ${GAME_NAME} alice,ghost`);
        expect(hasLine(alice.socket, line => /STARTG_ABORT #alice's_game :2$/.test(line))).toBe(true);
    });

    test("kicking a player removes them from the game", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `joingame ${GAME_NAME} 1 9 45 0 0 0 0`);
        server.handleMessage(bob.user, `joingame ${GAME_NAME} 0`);
        bob.socket.sent.length = 0;
        server.handleMessage(alice.user, `kick ${GAME_NAME} bob :goodbye`);
        expect(hasLine(bob.socket, line => /KICK #alice's_game bob$/.test(line))).toBe(true);
        expect(server.games.get(GAME_NAME)?.has("bob")).toBe(false);
    });
});

describe("WolServer lifecycle", () => {
    test("removes a user from channels and games on disconnect", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `join ${LOBBY} zotclot9`);
        server.handleMessage(bob.user, `join ${LOBBY} zotclot9`);
        expect(server.users.has("alice")).toBe(true);
        expect(server.users.has("bob")).toBe(true);
        server.handleClose(bob.user);
        expect(server.users.has("bob")).toBe(false);
        expect(alice.user.channels.has(LOBBY)).toBe(true);
        expect(server.channels.get(LOBBY)?.has("bob")).toBe(false);
    });

    test("closing a host's game deletes it and parts members", async () => {
        const { server, accounts, sessions } = makeServer();
        const alice = await login(server, accounts, sessions, "alice");
        const bob = await login(server, accounts, sessions, "bob");
        server.handleMessage(alice.user, `joingame ${GAME_NAME} 1 9 45 0 0 0 0`);
        server.handleMessage(bob.user, `joingame ${GAME_NAME} 0`);
        expect(server.games.has(GAME_NAME)).toBe(true);
        bob.socket.sent.length = 0;
        server.handleClose(alice.user);
        expect(server.games.has(GAME_NAME)).toBe(false);
        expect(hasLine(bob.socket, line => /PART #alice's_game$/.test(line))).toBe(true);
        expect(server.channels.get(LOBBY)).toBeUndefined();
    });
});
