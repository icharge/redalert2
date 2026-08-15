import { escapeChannelName } from "../src/protocol/lineCodec";

export interface WolTestClient {
    open: Promise<void>;
    send: (line: string) => void;
    waitFor: (predicate: (line: string) => boolean, name: string) => Promise<string>;
    close: () => void;
}

export function makeClient(wsUrl: string): WolTestClient {
    const ws = new WebSocket(wsUrl);
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
            ws.send(`PONG ${parts[1] ?? ""}\r\n`);
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
        send: (line: string) => ws.send(line + "\r\n"),
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

export async function registerOrLogin(baseUrl: string, username: string, password: string): Promise<string> {
    const body = JSON.stringify({ user: username, pass: password, locale: "en-US" });
    const register = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
    const registerData: any = await register.json().catch(() => ({}));
    if (registerData.sessionToken) {
        return registerData.sessionToken;
    }
    const login = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
    const data: any = await login.json().catch(() => ({}));
    if (!data.sessionToken) {
        throw new Error(`register/login failed for ${username}: ${JSON.stringify(data)}`);
    }
    return data.sessionToken;
}

export async function loginWs(client: WolTestClient, token: string): Promise<void> {
    client.send(`cvers 0.83.2 16640`);
    await client.waitFor(line => line.includes(" 700 "), "cvers 700");
    client.send(`session ${token}`);
    await client.waitFor(line => line.includes(" 376 "), "MOTD end 376");
}

export function joinChannel(client: WolTestClient, key: string, password?: string): Promise<string> {
    const lobby = escapeChannelName(key);
    client.send(`join ${lobby}${password ? " " + password : ""}`);
    return client.waitFor(line => new RegExp(`JOIN :\\d+,\\d+,\\d+,\\d+ ${lobby}$`).test(line), `join ${lobby}`);
}

export const SERVER_BASE = process.env.SERVER_URL ?? "http://127.0.0.1:9090";
export const WOL_URL = process.env.WOL_URL ?? "ws://127.0.0.1:9090";
