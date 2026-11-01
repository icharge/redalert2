import { afterAll, describe, expect, test } from "bun:test";
import { connect, Socket } from "node:net";
import { WolServer } from "../src/server/WolServer";
import { WolTcpGateway } from "../src/server/WolTcpGateway";
import { AccountStore } from "../src/auth/accountStore";
import { SessionManager } from "../src/auth/session";
import { GservManager } from "../src/gserv/GservManager";
import { WdtService } from "../src/wdt/service";
import { loadConfig } from "../src/config";
import { makeTestStorage } from "./helpers";

function make() {
    const config = loadConfig({});
    const accounts = new AccountStore(makeTestStorage(), config);
    const sessions = new SessionManager(makeTestStorage(), config.sessionTtlSeconds);
    const gservs = new GservManager({ id: "gs1", url: "ws://test.local/gserv" });
    const wdt = new WdtService({ edition: "ra2" });
    const wol = new WolServer(config, sessions, accounts, gservs, wdt);
    return { config, accounts, sessions, gservs, wdt, wol };
}

/** A native-style client: one TCP stream, CRLF lines, collect replies. */
class TcpClient {
    text = "";
    readonly socket: Socket;

    constructor(port: number) {
        this.socket = connect({ host: "127.0.0.1", port });
        this.socket.setEncoding("utf8");
        this.socket.on("data", (chunk: string) => { this.text += chunk; });
    }

    get connected(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket.once("connect", () => resolve());
            this.socket.once("error", reject);
        });
    }

    send(line: string): void {
        this.socket.write(`${line}\r\n`);
    }

    async waitFor(predicate: (line: string) => boolean, timeoutMs = 3000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const line = this.text.split(/\r?\n/).find(predicate);
            if (line) return line;
            if (Date.now() > deadline) throw new Error(`timed out; received:\n${this.text}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }

    close(): void {
        this.socket.destroy();
    }
}

const gateways: WolTcpGateway[] = [];
afterAll(async () => {
    for (const gateway of gateways) await gateway.close();
});

describe("native WOL TCP gateway", () => {
    test("shares the lobby: session login, LIST 33 and a WDT start over one TCP stream", async () => {
        const { accounts, sessions, gservs, wdt, wol } = make();
        await accounts.register("native1", "password123");
        const gateway = new WolTcpGateway(wol, { host: "127.0.0.1", port: 0 });
        gateways.push(gateway);
        const { port } = await gateway.start();

        const client = new TcpClient(port);
        await client.connected;
        client.send(`session ${sessions.create("native1")}`);

        // The shared line handlers answer exactly as they do over the WebSocket.
        const motd = await client.waitFor(line => line.includes(" 376 "));
        expect(motd).toContain("native1");
        expect(wol.users.get("native1")?.authenticated).toBe(true);

        client.send("list 33 33");
        expect(await client.waitFor(line => line.includes(" 322 ") && line.includes("#WDTmatch")))
            .toContain("#WDTmatch");

        // The click arrives after LIST; the server waits for it, then starts.
        client.send("wdtstart 7");
        const start = await client.waitFor(line => line.startsWith(":") && line.includes(" STARTG #WDTmatch "));
        const gameId = / :\S+ :(\S+) /.exec(start)?.[1];
        expect(gameId).toBeTruthy();
        // The click may arrive after STARTG; the server retargets the open conflict.
        for (let i = 0; i < 50 && gameId && wdt.conflictForGame(gameId)?.territoryId !== 7; i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const conflict = gameId ? wdt.conflictForGame(gameId) : undefined;
        expect(conflict?.territoryId).toBe(7);
        expect(gservs.getDefault().url).toBe("ws://test.local/gserv");

        client.close();
        // The disconnect path releases the shared user record.
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(wol.users.has("native1")).toBe(false);
    });

    test("forwards a plain WOL command loop and drops an oversized line", async () => {
        const { accounts, sessions, wol } = make();
        await accounts.register("native2", "password123");
        const gateway = new WolTcpGateway(wol, { host: "127.0.0.1", port: 0, maxLineBytes: 128 });
        gateways.push(gateway);
        const { port } = await gateway.start();

        const client = new TcpClient(port);
        await client.connected;
        client.send(`session ${sessions.create("native2")}`);
        await client.waitFor(line => line.includes(" 376 "));

        client.socket.write("ping native2\r\n");
        expect(await client.waitFor(line => line.startsWith(":") && line.includes(" PONG native2 :native2"))).toBeTruthy();

        const closed = new Promise<void>(resolve => client.socket.once("close", () => resolve()));
        client.socket.write(`privmsg #x :${"a".repeat(200)}\r\n`);
        await closed;
        expect(wol.users.has("native2")).toBe(false);
    });
});
