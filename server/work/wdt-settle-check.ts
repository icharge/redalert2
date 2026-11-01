/**
 * Drive a finished WDT match for a server-started conflict: log in, start the
 * match with a chosen territory, then POST a native game-res packet declaring
 * the local player the winner. Verifies /wdt/status history + territory owner.
 */
import { makeClient, loginWs, joinChannel, registerOrLogin, SERVER_BASE, WOL_URL } from "../scripts/wolLib";

const nick = "wdtres";
const territory = Number(process.env.WDT_TERRITORY ?? "14");

function field(name: string, type: number, length: number, payload: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.write(name, 0, 4, "latin1");
    head.writeUInt16BE(type, 4);
    head.writeUInt16BE(length, 6);
    const padded = Buffer.alloc(Math.ceil(length / 4) * 4);
    payload.copy(padded);
    return Buffer.concat([head, padded]);
}
const num = (name: string, value: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value);
    return field(name, 6, 4, b);
};
const text = (name: string, value: string) => {
    const b = Buffer.from(value + "\0", "latin1");
    return field(name, 7, b.length, b);
};

const token = await registerOrLogin(SERVER_BASE, nick, "password123");
const client = makeClient(WOL_URL);
await client.open;
await loginWs(client, token);
await joinChannel(client, "#Lob 33 0", "zotclot9");
client.send(`wdtstart ${territory}`);
client.send("list 33 33");
const startg = await client.waitFor(line => line.includes(" STARTG "), "STARTG");
const gameId = /:(g[1-9]\d*-[a-z0-9]+)/.exec(startg)?.[1];
if (!gameId) throw new Error(`no game id in ${startg}`);
const gameNumber = Number(/^g([1-9]\d*)-/.exec(gameId)![1]);
console.log("game", gameId);

const parts = [
    num("IDNO", gameNumber),
    num("GSKU", 16640),
    num("DURA", 60),
    text("SCEN", "WDT"),
    num("AIPL", 0),
    num("PLRS", 1),
    num("FINI", 1),
    num("OOSY", 0),
    text("NAM0", nick),
    num("CMP0", 256),
];
const body = Buffer.concat([Buffer.alloc(4), ...parts]);
body.writeUInt16BE(body.length, 0);

const response = await fetch(`${SERVER_BASE}/native-results/${gameId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body,
});
console.log("report", response.status, await response.text());

const status = await (await fetch(`${SERVER_BASE}/wdt/status`)).json() as {
    history: Array<{ conflictId: number; winner: number }>;
    territories: Array<{ id: number; owner: number }>;
};
const owner = status.territories.find(t => t.id === territory)?.owner;
console.log("history", status.history.length, status.history.at(-1), "owner", owner);
client.close();
if (status.history.length === 0 || owner !== 0) {
    console.error("settlement not applied");
    process.exit(1);
}
console.log("settlement OK");
