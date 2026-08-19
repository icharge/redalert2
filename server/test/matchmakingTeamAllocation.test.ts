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

async function queue(server: WolServer, accounts: AccountStore, sessions: SessionManager, username: string, channelType = 50): Promise<FakeSocket> {
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
        TAG_VERSION + "=0.83.4-abc123",
        TAG_MODHASH + "=deadbeef",
        TAG_RANKED + "=1",
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
