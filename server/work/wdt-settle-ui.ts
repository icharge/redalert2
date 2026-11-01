/**
 * Settle the most recent UI-created WDT conflict: log in as the browser user,
 * post a native game-res packet for that conflict's gameId, then assert the
 * history entry and the territory owner change.
 */
const base = process.env.SERVER_URL ?? "http://127.0.0.1:19094";
const user = process.env.WOL_TEST_USER ?? "woltst9";
const pass = process.env.WOL_TEST_PASSWORD ?? "wolpass1";

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

const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, pass }),
});
const { sessionToken } = await login.json() as { sessionToken?: string };
if (!sessionToken) throw new Error(`login failed: ${login.status}`);
console.log("login ok");

const before = await (await fetch(`${base}/wdt/status`)).json() as {
    conflicts: Array<{ id: number; gameId?: string; territoryId: number; attacker: number }>;
};
const conflict = before.conflicts.at(-1);
if (!conflict?.gameId) throw new Error("no UI conflict with a game id");
const gameNumber = Number(/^g([1-9]\d*)-/.exec(conflict.gameId)![1]);
console.log("settling", conflict);

const parts = [
    num("IDNO", gameNumber),
    num("GSKU", 16640),
    num("DURA", 60),
    text("SCEN", "WDT"),
    num("AIPL", 0),
    num("PLRS", 1),
    num("FINI", 1),
    num("OOSY", 0),
    text("NAM0", user),
    num("CMP0", 256),
];
const body = Buffer.concat([Buffer.alloc(4), ...parts]);
body.writeUInt16BE(body.length, 0);

const response = await fetch(`${base}/native-results/${conflict.gameId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/octet-stream" },
    body,
});
console.log("report", response.status, await response.text());

const after = await (await fetch(`${base}/wdt/status`)).json() as {
    history: Array<{ conflictId: number; territoryId: number; from: number; to: number; gameId: string }>;
    territories: Array<{ id: number; owner: number }>;
};
const entry = after.history.find(h => h.gameId === conflict.gameId);
const owner = after.territories.find(t => t.id === conflict.territoryId)?.owner;
console.log("history", after.history.length, entry, "owner", owner);
if (!entry || owner !== conflict.attacker) {
    console.error("settlement not applied to the UI conflict");
    process.exit(1);
}
console.log("UI conflict settled OK");
