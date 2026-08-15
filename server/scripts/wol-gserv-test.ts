/**
 * Gserv handoff test: exercises the match relay server end to end.
 *
 * Creates a game on the WOL server, starts it, captures the per-player
 * ticket, then connects to the gserv endpoint and runs the match protocol:
 *   cvers -> ticket -> join -> gameopts -> loaded 100 -> GAME_START (700)
 *
 * Usage:
 *   bun run scripts/wol-gserv-test.ts
 */
import { makeClient, loginWs, registerOrLogin, SERVER_BASE, WOL_URL } from "./wolLib";
import { escapeChannelName } from "../src/protocol/lineCodec";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
    if (ok) {
        console.log(`  [ok]   ${name}`);
    }
    else {
        failures += 1;
        console.log(`  [FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
    }
}

function makeBinaryClient(url: string) {
    const ws = new WebSocket(url);
    const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("gserv websocket error")));
    });
    const waiters: Array<{ predicate: (line: string) => boolean; resolve: (line: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
    const buffer: string[] = [];
    ws.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") {
            return;
        }
        const data = String(event.data).replace(/\r?\n$/, "");
        for (const w of [...waiters]) {
            if (w.predicate(data)) {
                clearTimeout(w.timer);
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(data);
                return;
            }
        }
        buffer.push(data);
    });
    return {
        open: opened,
        send: (data: string | Uint8Array) => ws.send(typeof data === "string" ? data + "\r\n" : data),
        waitFor: (predicate: (line: string) => boolean, name: string) => {
            const index = buffer.findIndex(predicate);
            if (index !== -1) {
                return Promise.resolve(buffer.splice(index, 1)[0]);
            }
            return new Promise<string>((resolve, reject) => {
                const w = {
                    predicate,
                    resolve: (line: string) => resolve(line),
                    reject: (err: Error) => reject(err),
                    timer: setTimeout(() => {
                        waiters.splice(waiters.indexOf(w), 1);
                        reject(new Error(`timeout waiting for gserv "${name}"`));
                    }, 5000),
                };
                waiters.push(w);
            });
        },
        close: () => ws.close(),
    };
}

async function main(): Promise<void> {
    const username = "gservtest";
    const token = await registerOrLogin(SERVER_BASE, username, "password123");
    const wol = makeClient(WOL_URL);
    await wol.open;
    await loginWs(wol, token);

    const gameName = escapeChannelName(`#${username}'s game`);
    wol.send(`joingame ${gameName} 1 9 45 0 0 0 0`);
    await wol.waitFor(line => new RegExp(`JOINGAME [^:]+:${gameName}$`).test(line), "create game");

    const mapTitle = Buffer.from("Gserv Test Map", "utf16le").toString("base64");
    const aiPart = new Array(8).fill("0,-1,-1,-1,-1").join(",");
    const fullOpts = `0,0,2,10000,100,0,0,1,1,0,1,0,${mapTitle},2,1,1000,mpdefault,abc123,1,0,0,1,0:${username},0,0,0,0,0,0,0:@:${aiPart},`;
    wol.send(`gameopt ${gameName} :${fullOpts}`);
    wol.send(`topic ${gameName} :g19N39,0,0,0,0,mpdefault,,,,0.83.2`);

    wol.send(`startg ${gameName} ${username}`);
    const startg = await wol.waitFor(line => line.includes(" STARTG "), "STARTG");
    const match = startg.match(/STARTG \S+ :(\S+) :(\S+) (\d+) (\S+)$/);
    check("STARTG carries gserv url, game id, timestamp, ticket", !!match, startg);
    if (!match) {
        process.exit(1);
    }
    const [, gservUrl, gameId, timestamp, ticket] = match;

    const gserv = makeBinaryClient(gservUrl);
    await gserv.open;

    gserv.send(`cvers 0.83.2 3`);
    const cvers = await gserv.waitFor(line => line.includes(" 10 "), "gserv cvers 10");
    check("gserv cvers accepted (10)", / 10 /.test(cvers), cvers);

    gserv.send(`ticket ${ticket}`);
    const loggedIn = await gserv.waitFor(line => line.includes(" 100 "), "gserv ticket 100");
    check("gserv ticket logged in (100)", / 100 /.test(loggedIn), loggedIn);

    gserv.send(`join ${gameId} ${timestamp} ${ticket}`);
    const connected = await gserv.waitFor(line => line.includes(" 400 "), "gserv join 400");
    check("gserv join instance connected (400)", / 400 /.test(connected), connected);

    gserv.send(`gameopts`);
    const opts = await gserv.waitFor(line => line.includes(" 500 "), "gserv gameopts 500");
    check("gserv returned gameopts (500)", / 500 .*:0,0,/.test(opts), opts);

    gserv.send(`privmsg #all :gl hf`);
    gserv.send(`taunt 4`);

    const actions = Uint8Array.from([0x02, 0x01, 0, 0, 0, 5, 10, 20]);
    gserv.send(actions);

    gserv.send(`loaded 100`);
    const gameStart = await gserv.waitFor(line => line.includes(" 700 "), "gserv game start 700");
    check("gserv signals game start (700)", / 700 /.test(gameStart), gameStart);

    gserv.close();
    wol.send(`part ${gameName}`);
    await wol.waitFor(line => new RegExp(`PART ${gameName}$`).test(line), "part game");
    wol.close();

    console.log(failures === 0 ? "\nGSERV TEST PASSED" : `\nGSERV TEST FAILED (${failures} failures)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
    console.error("GSERV TEST ERROR:", error);
    process.exit(1);
});
