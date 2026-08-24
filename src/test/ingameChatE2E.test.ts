import { describe, expect, test } from "bun:test";
import { IrcConnection } from "@/network/IrcConnection";
import { GservConnection } from "@/network/GservConnection";
import { ChatNetHandler } from "@/gui/screen/game/ChatNetHandler";
import { MessageList } from "@/gui/screen/game/component/hud/viewmodel/MessageList";
import { ChatHistory } from "@/gui/chat/ChatHistory";
import { ChatMessageFormat } from "@/gui/chat/ChatMessageFormat";
import { ChatRecipientType } from "@/network/chat/ChatMessage";
import { WolServer } from "../../server/src/server/WolServer";
import { AccountStore } from "../../server/src/auth/accountStore";
import { SessionManager } from "../../server/src/auth/session";
import { GservServer } from "../../server/src/gserv/GservServer";
import { GservManager } from "../../server/src/gserv/GservManager";
import { loadConfig } from "../../server/src/config";
import { FakeSocket } from "../../server/test/helpers";

const LOBBY = "#Lob_45_0";
const GAME_NAME = "#alice's_game";

class FakeIrc extends IrcConnection {
    sent: Array<string | Uint8Array> = [];
    constructor() {
        super({ mode: "text" } as any, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any);
        (this as any).socket = { readyState: 1, send: (data: string | Uint8Array) => this.sent.push(data) };
    }
    dispatch(line: string): void {
        (this as any)._onMessage.dispatch(this, line);
    }
}

class FakeGame {
    currentTick = 10;
    alliances = {
        getAllies: (player: { name: string }) => this.players.filter((p) => p.name !== player.name),
    };
    players: Array<{ name: string; color: { asHexString(): string } }>;
    constructor(names: string[]) {
        this.players = names.map((name) => ({ name, color: { asHexString: () => "#00ff00" } }));
    }
    getPlayerByName(name: string) {
        const player = this.players.find((p) => p.name === name);
        if (!player) {
            throw new Error(`Player with name "${name}" not found`);
        }
        return player;
    }
}

function fakeWolForChat() {
    const listeners: Array<(m: any) => void> = [];
    return {
        isOpen: () => true,
        getServerName: () => "wol-ra2web",
        getCurrentUser: () => "alice",
        onChatMessage: {
            subscribe: (fn: (m: any) => void) => listeners.push(fn),
            unsubscribe: (fn: (m: any) => void) => {
                const i = listeners.indexOf(fn);
                if (i >= 0) listeners.splice(i, 1);
            },
        },
        dispatch: (m: any) => listeners.forEach((fn) => fn(m)),
    };
}

function makeChatHandler(gserv: GservConnection, wol: any, localName: string, players: string[]) {
    const messageList = new MessageList(8, 6, players.includes(localName) ? { name: localName, color: { asHexString: () => "#fff" } } : undefined);
    const chatHistory = new ChatHistory();
    const game = new FakeGame(players);
    const handler = new ChatNetHandler(
        gserv,
        wol,
        messageList,
        chatHistory,
        new ChatMessageFormat({ get: (key: string, ...args: any[]) => key + (args.length ? ":" + args.join(",") : "") }, localName),
        { name: localName, color: { asHexString: () => "#fff" } },
        game,
        { recordChatMessage: () => {} },
        new Set<string>(),
        undefined,
    );
    handler.init();
    return { messageList, chatHistory, handler, game };
}

async function setupServer() {
    const config = loadConfig({});
    const accounts = new AccountStore((await import("../../server/test/helpers")).makeTestStorage(), config);
    const sessions = new SessionManager((await import("../../server/test/helpers")).makeTestStorage(), config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const wol = new WolServer(config, sessions, accounts, gservs);
    const gserv = new GservServer(config, gservs);
    await accounts.register("alice", "password123");
    await accounts.register("bob", "password123");
    const aliceToken = sessions.create("alice");
    const bobToken = sessions.create("bob");
    return { config, accounts, sessions, gservs, wol, gserv, aliceToken, bobToken };
}

async function wolLogin(wol: WolServer, token: string): Promise<FakeSocket> {
    const socket = new FakeSocket();
    const user = wol.handleOpen(socket);
    wol.handleMessage(user, `session ${token}`);
    return socket;
}

describe("E2E: in-game chat over the real WOL+gserv stack", () => {
    test("chat sent by alice arrives at bob's in-game HUD", async () => {
        const { wol, gserv, aliceToken, bobToken } = await setupServer();

        // WOL lobby login
        const aliceWs = await wolLogin(wol, aliceToken);
        const bobWs = await wolLogin(wol, bobToken);
        wol.handleMessage(wol.users.get("alice")!, `join ${LOBBY} zotclot9`);
        wol.handleMessage(wol.users.get("bob")!, `join ${LOBBY} zotclot9`);

        // Create game, bob joins, host sets topic and starts
        wol.handleMessage(wol.users.get("alice")!, `joingame ${GAME_NAME} 1 9 45 0 0 0 0`);
        wol.handleMessage(wol.users.get("bob")!, `joingame ${GAME_NAME} 0`);
        wol.handleMessage(wol.users.get("alice")!, `topic ${GAME_NAME} :g19N39,0,0,0,0,mpdefault,,,,0.83.4`);
        wol.handleMessage(wol.users.get("alice")!, `startg ${GAME_NAME} alice,bob`);

        // Parse STARTG lines -> tickets
        const parseStartg = (ws: FakeSocket) => {
            const line = ws.lines().find((l) => l.startsWith(":wol-ra2web STARTG "))!;
            const [, , , gameIdTs] = line.split(" ");
            const gservUrl = line.split(" :")[1].split(" ")[0];
            const rest = line.split(" :").slice(2).join(" :");
            const [gameId, timestamp, ticket] = rest.split(" ");
            return { gservUrl, gameId, timestamp, ticket };
        };
        const aliceStart = parseStartg(aliceWs);
        const bobStart = parseStartg(bobWs);
        expect(aliceStart.gameId).toBe(bobStart.gameId);

        // gserv connections (real client classes)
        const aliceIrc = new FakeIrc();
        const bobIrc = new FakeIrc();
        const aliceGserv = new GservConnection(aliceIrc, {} as any);
        const bobGserv = new GservConnection(bobIrc, {} as any);
        (aliceGserv as any).con.onMessage.subscribe((aliceGserv as any).handleMessage);
        (bobGserv as any).con.onMessage.subscribe((bobGserv as any).handleMessage);

        const aliceClient = gserv.handleOpen(aliceWs);
        const bobClient = gserv.handleOpen(bobWs);
        (aliceGserv as any).currentUser = "alice";
        (aliceGserv as any).serverName = "gserv-ra2web";
        (bobGserv as any).currentUser = "bob";
        (bobGserv as any).serverName = "gserv-ra2web";
        gserv.handleMessage(aliceClient, `ticket ${aliceStart.ticket}`);
        gserv.handleMessage(bobClient, `ticket ${bobStart.ticket}`);
        gserv.handleMessage(aliceClient, `join ${aliceStart.gameId}`);
        gserv.handleMessage(bobClient, `join ${bobStart.gameId}`);
        gserv.handleMessage(aliceClient, "loaded 100");
        gserv.handleMessage(bobClient, "loaded 100");

        // In-game chat wiring (real ChatNetHandler)
        const aliceChat = makeChatHandler(aliceGserv, fakeWolForChat(), "alice", ["alice", "bob"]);
        const bobChat = makeChatHandler(bobGserv, fakeWolForChat(), "bob", ["alice", "bob"]);

        // ---- alice sends a chat message in-game ----
        aliceChat.handler.submitMessage("hello bob", { type: ChatRecipientType.Channel, name: "#all" });
        const aliceWire = aliceIrc.sent.find((s): s is string => typeof s === "string" && s.startsWith("privmsg"));
        expect(aliceWire).toBe("privmsg #all :hello bob\r\n");

        // The sender's own message must appear in their HUD immediately
        // (client-side echo, like the WOL lobby does).
        expect(aliceChat.messageList.messages).toHaveLength(1);
        expect(aliceChat.messageList.messages[0].text).toContain("hello bob");

        // Feed alice's wire message into the real server
        gserv.handleMessage(aliceClient, aliceWire!);

        // Server must relay to bob
        const relayed = bobWs.lines().find((l) => l.includes("PRIVMSG #all :hello bob"));
        expect(relayed).toBe(":alice PRIVMSG #all :hello bob");

        // Feed the relayed line into bob's real gserv connection -> HUD
        bobIrc.dispatch(relayed!);
        expect(bobChat.messageList.messages).toHaveLength(1);
        expect(bobChat.messageList.messages[0].text).toContain("hello bob");
        expect(bobChat.messageList.messages[0].text).toContain("alice");

        // ---- team chat: comma-separated recipient list ----
        aliceChat.handler.submitMessage("hi team", { type: ChatRecipientType.Channel, name: "#team" });
        const teamWire = aliceIrc.sent.filter((s): s is string => typeof s === "string" && s.startsWith("privmsg")).at(-1);
        expect(teamWire).toBe("privmsg bob,alice :hi team\r\n");
        expect(aliceChat.messageList.messages).toHaveLength(2);
        expect(aliceChat.messageList.messages[1].text).toContain("hi team");

        gserv.handleMessage(aliceClient, teamWire!);
        const bobTeamLines = bobWs.lines().filter((l) => l.includes("PRIVMSG bob :hi team"));
        expect(bobTeamLines.length).toBe(1);
        bobIrc.dispatch(bobTeamLines[0]);
        expect(bobChat.messageList.messages).toHaveLength(2);
        expect(bobChat.messageList.messages[1].text).toContain("hi team");

        // ---- server PING/PONG keepalive traffic must not break chat ----
        bobIrc.dispatch(":gserv-ra2web PONG bob :1723788990123");
        expect(bobChat.messageList.messages).toHaveLength(2);

        // ---- server control messages must never render as chat ----
        (bobChat.handler as any).gservCon._onChatMessage.dispatch(bobChat.handler.gservCon, {
            from: "gserv-ra2web",
            to: { type: ChatRecipientType.Channel, name: "#all" },
            text: "GSERV PONG bob :1723788990123",
            time: new Date(),
        });
        expect(bobChat.messageList.messages).toHaveLength(2);
        (bobChat.handler as any).wolCon.dispatch({
            from: "wol-ra2web",
            to: { type: ChatRecipientType.Page, name: "bob" },
            text: "PONG bob :1723788990123",
            time: new Date(),
        });
        expect(bobChat.messageList.messages).toHaveLength(2);

        // ---- lobby chat arriving on the WOL connection while in-game ----
        (bobChat.handler as any).wolCon.dispatch({
            from: "carol",
            to: { type: ChatRecipientType.Channel, name: LOBBY },
            text: "lobby chatter",
            time: new Date(),
        });
        expect(bobChat.messageList.messages).toHaveLength(2);
    });
});
