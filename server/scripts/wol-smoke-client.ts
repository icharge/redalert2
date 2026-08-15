/**
 * End-to-end smoke test client for the RA2Web WOL server.
 *
 * Speaks the same line-based WOL protocol as the game client
 * (src/network/WolConnection.ts) over a real WebSocket, exercising:
 * register/login -> session -> join lobby -> NAMES -> chat -> create game
 * -> topic -> LIST -> gameopt -> startg (gserv handoff) -> part.
 *
 * Usage:
 *   bun run scripts/wol-smoke-client.ts
 *
 * Env:
 *   SERVER_URL   base http url, default http://127.0.0.1:9090
 *   WOL_URL      ws url,        default ws://127.0.0.1:9090
 */
import { escapeChannelName } from "../src/protocol/lineCodec";

const BASE_URL = process.env.SERVER_URL ?? "http://127.0.0.1:9090";
const WOL_URL = process.env.WOL_URL ?? "ws://127.0.0.1:9090";

const username = "smoke";
const password = "password123";

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

async function registerOrLogin(): Promise<string> {
    const body = JSON.stringify({ user: username, pass: password, locale: "en-US" });
    const register = await fetch(`${BASE_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
    if (register.status === 200) {
        const data: any = await register.json();
        check("register new account", !!data.sessionToken);
        return data.sessionToken;
    }
    const login = await fetch(`${BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
    const data: any = await login.json();
    check("login existing account", !!data.sessionToken);
    return data.sessionToken;
}

function makeClient(): { open: Promise<void>; send: (line: string) => void; waitFor: (predicate: (line: string) => boolean, name: string) => Promise<string>; close: () => void } {
    const ws = new WebSocket(WOL_URL);
    const buffer: string[] = [];
    const waiters: Array<{ predicate: (line: string) => boolean; name: string; resolve: (line: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
    const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("websocket error")));
    });
    ws.addEventListener("message", (event: MessageEvent) => {
        const data = String(event.data).replace(/\r?\n$/, "");
        const parts = data.split(" ");
        if (parts[0]?.toLowerCase() === "ping") {
            ws.send(`PONG ${parts[1] ?? ""}`);
            return;
        }
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
    ws.addEventListener("close", () => {
        for (const w of [...waiters]) {
            clearTimeout(w.timer);
            w.reject(new Error(`connection closed while waiting for "${w.name}"`));
        }
        waiters.length = 0;
    });
    return {
        open: opened,
        send: (line: string) => ws.send(line),
        waitFor: (predicate, name) => {
            const index = buffer.findIndex(predicate);
            if (index !== -1) {
                const line = buffer.splice(index, 1)[0];
                return Promise.resolve(line);
            }
            return new Promise<string>((resolve, reject) => {
                const w = {
                    predicate,
                    name,
                    resolve: (line: string) => resolve(line),
                    reject: (err: Error) => reject(err),
                    timer: setTimeout(() => {
                        waiters.splice(waiters.indexOf(w), 1);
                        reject(new Error(`timeout waiting for "${name}" (have: ${buffer.join(" | ")})`));
                    }, 5000),
                };
                waiters.push(w);
            });
        },
        close: () => ws.close(),
    };
}

async function main(): Promise<void> {
    const sessionToken = await registerOrLogin();
    const client = makeClient();
    await client.open;

    client.send(`cvers 0.83.2 16640`);
    const cversReply = await client.waitFor(line => line.includes(" 700 "), "cvers 700");
    check("cvers accepted (700)", / 700 /.test(cversReply), cversReply);

    client.send(`setlocale 2`);
    await client.waitFor(line => line.includes(" 310 "), "setlocale 310");
    check("setlocale accepted (310)", true);

    client.send(`session ${sessionToken}`);
    const motdEnd = await client.waitFor(line => line.includes(" 376 "), "MOTD end 376");
    check("session authenticated (376)", / 376 /.test(motdEnd), motdEnd);

    const lobbyKey = escapeChannelName("#Lob 45 0");
    client.send(`join ${lobbyKey} zotclot9`);
    await client.waitFor(line => /JOIN :\d+,\d+,\d+,\d+ #Lob_45_0$/.test(line), "own JOIN");
    await client.waitFor(line => line.includes(" 353 ") && line.includes(lobbyKey), "NAMES 353");
    await client.waitFor(line => line.includes(" 366 ") && line.includes(lobbyKey), "NAMES end 366");
    check("joined lobby channel (JOIN+NAMES)", true);

    client.send(`NAMES ${lobbyKey}`);
    await client.waitFor(line => line.includes(" 366 "), "explicit NAMES");
    check("explicit NAMES replied", true);

    client.send(`privmsg ${lobbyKey} :hello from smoke test`);
    check("sent channel message", true);

    const gameName = escapeChannelName(`#${username}'s game`);
    client.send(`joingame ${gameName} 1 9 45 0 0 0 0`);
    await client.waitFor(line => new RegExp(`JOINGAME [^:]+:${gameName}$`).test(line), "own JOINGAME");
    await client.waitFor(line => line.includes(" 353 ") && line.includes(`= ${gameName} :@${username}`), "game NAMES host");
    await client.waitFor(line => line.includes(" GSERV "), "GSERV announce");
    check("created game channel", true);

    const descB64 = Buffer.from("smoke game", "utf16le").toString("base64");
    const topic = `g19N39,0,0,0,0,mpdefault,${descB64},,0.83.2`;
    client.send(`topic ${gameName} :${topic}`);

    client.send(`list 45 45`);
    await client.waitFor(line => line.includes(" 321 "), "LIST start 321");
    const listEntry = await client.waitFor(line => line.includes(" 322 ") && line.includes(gameName), "LIST entry 322");
    await client.waitFor(line => line.includes(" 323 "), "LIST end 323");
    check("game listed with topic", /322 .*45::g19N39/.test(listEntry), listEntry);

    client.send(`gameopt ${gameName} :A1`);
    client.send(`startg ${gameName} ${username}`);
    const startg = await client.waitFor(line => line.includes(" STARTG ") && line.includes(gameName), "STARTG");
    check("startg delivered gserv handoff", /STARTG .*:ws:\/\/\S+ :g\d/.test(startg), startg);

    client.send(`part ${gameName}`);
    await client.waitFor(line => new RegExp(`PART ${gameName}$`).test(line), "PART game");
    client.send(`part ${lobbyKey}`);
    await client.waitFor(line => new RegExp(`PART ${lobbyKey}$`).test(line), "PART lobby");
    check("left channels (PART)", true);

    client.close();
    console.log(failures === 0 ? "\nSMOKE TEST PASSED" : `\nSMOKE TEST FAILED (${failures} failures)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
    console.error("SMOKE TEST ERROR:", error);
    process.exit(1);
});
