import { describe, expect, test } from "bun:test";
import { WolServer } from "../src/server/WolServer";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { GservManager } from "../src/gserv/GservManager";
import { loadConfig, ServerConfig } from "../src/config";
import { escapeChannelName } from "../src/protocol/lineCodec";
import { FakeSocket, hasLine, makeTestStorage } from "./helpers";
import { RPL_WORKING, TAG_COUNTRY, TAG_COLOR, TAG_VERSION, TAG_MODHASH, TAG_RANKED } from "../src/protocol/qmCodes";

function makeServer(): { config: ServerConfig; server: WolServer; accounts: AccountStore; sessions: SessionManager } {
    const config = loadConfig({ GAME_VERSION: "0.83.4" });
    const accounts = new AccountStore(makeTestStorage(), config);
    const sessions = new SessionManager(makeTestStorage(), config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const server = new WolServer(config, sessions, accounts, gservs);
    return { config, server, accounts, sessions };
}

async function queue(server: WolServer, accounts: AccountStore, sessions: SessionManager, username: string, channelType = 50, version = "0.83.4-abc123", ranked = true): Promise<FakeSocket> {
    await accounts.register(username, "password123");
    const token = sessions.create(username);
    const socket = new FakeSocket();
    const user = server.handleOpen(socket);
    server.handleMessage(user, `session ${token}`);
    user.fresh = false;
    server.handleMessage(user, `join ${escapeChannelName(`#Lob ${channelType} 0`)} zotclot9`);
    const request = [
        TAG_COUNTRY + "=0",
        TAG_COLOR + "=0",
        TAG_VERSION + "=" + version,
        TAG_MODHASH + "=deadbeef",
        TAG_RANKED + "=" + (ranked ? 1 : 0),
    ].join(", ");
    server.handleMessage(user, `PRIVMSG matchbot :Match ${request}`);
    return socket;
}

// `instance.gameopts` format: `optionsPart:playersPart:@:aiPart,`
// optionsPart ends with `...,instantCapture,delayedOils,lockAlliances`
// playersPart is a flat list of 8-field records `name,countryId,colorId,startPos,teamId,0,0,0`.
function parseTeams(gameopts: string): { lockAlliances: boolean; teams: Map<string, number> } {
    const [optionsPart, playersPart] = gameopts.split(":");
    const optionsFields = optionsPart.split(",");
    const lockAlliances = optionsFields[optionsFields.length - 1] === "1";
    const playerFields = playersPart.split(",");
    const teams = new Map<string, number>();
    for (let i = 0; i < playerFields.length; i += 8) {
        const name = playerFields[i];
        const teamId = Number(playerFields[i + 4]);
        teams.set(name, teamId);
    }
    return { lockAlliances, teams };
}

describe("matchmaking team allocation", () => {
    test("1v1 quick match assigns team 0/1 and locks alliances", async () => {
        const { server, accounts, sessions } = makeServer();
        await queue(server, accounts, sessions, "alice");
        await queue(server, accounts, sessions, "bob");
        const instance = [...server.gservs.instances.values()][0];
        expect(instance).toBeDefined();
        const { lockAlliances, teams } = parseTeams(instance!.gameopts!);
        expect(lockAlliances).toBe(true);
        expect(teams.get("alice")).toBe(0);
        expect(teams.get("bob")).toBe(1);
    });

    test("2v2 quick match (parties of two) assigns teams 0/0 vs 1/1", () => {
        const { server } = makeServer();
        const bot: any = server.matchbot;
        const gameopts = bot.buildDefaultGameOpts(
            { key: "p1", players: ["alice", "carol"], channelType: 51, ranked: true },
            { key: "p2", players: ["bob", "dave"], channelType: 51, ranked: true },
        );
        const { lockAlliances, teams } = parseTeams(gameopts);
        expect(lockAlliances).toBe(true);
        expect(teams.get("alice")).toBe(0);
        expect(teams.get("carol")).toBe(0);
        expect(teams.get("bob")).toBe(1);
        expect(teams.get("dave")).toBe(1);
        expect(teams.size).toBe(4);
    });

    test("a Match from the WDT matching lobby is a WDT match without wdtstart", async () => {
        const { server, accounts, sessions } = makeServer();
        const queueFromBothLobbies = async (username: string) => {
            await accounts.register(username, "password123");
            const token = sessions.create(username);
            const socket = new FakeSocket();
            const user = server.handleOpen(socket);
            server.handleMessage(user, `session ${token}`);
            user.fresh = false;
            // The native client can still be in the main lobby when the WDT
            // match request goes out.
            server.handleMessage(user, `join ${escapeChannelName("#Lob 33 0")} zotclot9`);
            server.handleMessage(user, `join ${escapeChannelName("#Lob 35 0")} zotclot9`);
            server.handleMessage(user, `PRIVMSG matchbot :Match COU=US, COL=0, VRS=1.006, RKD=0`);
            return socket;
        };
        const socketA = await queueFromBothLobbies("alice");
        await queueFromBothLobbies("bob");
        const instance = [...server.gservs.instances.values()][0];
        expect(instance).toBeDefined();
        expect([...server.games.keys()]).toContain("#WDTmatch");
        expect(instance!.nativeSku).toBe(16640);
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && !hasLine(socketA, line => line.includes(" GAMEOPT "))) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(hasLine(socketA, line => line.includes(" GAMEOPT ") && line.includes("WDS=0"))).toBe(true);
    }, 20000);

    test("the quick-match lobby wins over the main lobby", async () => {
        const { server, accounts, sessions } = makeServer();
        await accounts.register("alice", "password123");
        await accounts.register("bob", "password123");
        const queueFrom = async (username: string) => {
            const token = sessions.create(username);
            const socket = new FakeSocket();
            const user = server.handleOpen(socket);
            server.handleMessage(user, `session ${token}`);
            user.fresh = false;
            server.handleMessage(user, `join ${escapeChannelName("#Lob 33 0")} zotclot9`);
            server.handleMessage(user, `join ${escapeChannelName("#Lob 50 0")} zotclot9`);
            server.handleMessage(user, `PRIVMSG matchbot :Match COU=US, COL=0, VRS=0.83.4-abc123, RKD=1`);
            return socket;
        };
        await queueFrom("alice");
        await queueFrom("bob");
        const instance = [...server.gservs.instances.values()][0];
        expect(instance).toBeDefined();
        expect([...server.games.keys()]).not.toContain("#WDTmatch");
    });

    test("the matchbot sends GAMEOPT and picks the retail random map for native clients", async () => {
        const { server, accounts, sessions } = makeServer();
        const socketA = await queue(server, accounts, sessions, "alice", 50, "1.006", false);
        const socketB = await queue(server, accounts, sessions, "bob", 50, "1.006", false);
        const instance = [...server.gservs.instances.values()][0];
        expect(instance).toBeDefined();
        // The retail client only ships RandMap.Map (it generates the map);
        // "mpdefault" exists only in the RA2Web map set.
        expect(instance!.gameopts).toContain(",RandMap.Map,");
        const wants = (line: string) => line.includes(" GAMEOPT ") || line.includes(" JOINGAME ");
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline &&
            !(hasLine(socketA, wants) && hasLine(socketB, wants))) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        for (const socket of [socketA, socketB]) {
            expect(hasLine(socket, line => line.includes(" GAMEOPT ") && line.includes("RandMap.Map"))).toBe(true);
            // The native client identifies the host by the channel operator in
            // the room's 353 roster, and only accepts NET_GO from that user.
            expect(hasLine(socket, line => line.includes(" 353 ") && line.includes(" :@alice,"))).toBe(true);
            expect(hasLine(socket, line => line.includes(" 353 ") && line.includes(" bob,"))).toBe(true);
        }
    }, 20000);

    test("a web quick match keeps the RA2Web map", async () => {
        const { server, accounts, sessions } = makeServer();
        await queue(server, accounts, sessions, "alice");
        await queue(server, accounts, sessions, "bob");
        const instance = [...server.gservs.instances.values()][0];
        expect(instance!.gameopts).toContain(",mpdefault,");
    });

    test("quick match 1v1 actually pairs the two queued users", async () => {
        const { server, accounts, sessions } = makeServer();
        const socketA = await queue(server, accounts, sessions, "alice");
        await queue(server, accounts, sessions, "bob");
        expect(hasLine(socketA, line => line.includes(RPL_WORKING))).toBe(true);
        const instance = [...server.gservs.instances.values()][0];
        expect(instance).toBeDefined();
        const { teams } = parseTeams(instance!.gameopts!);
        expect([...teams.keys()].sort()).toEqual(["alice", "bob"]);
    });
});
