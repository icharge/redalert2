/**
 * Live check for the server-side WDT territory contract: send `wdtstart <id>`
 * then `list 33 33` and confirm STARTG + the conflict uses that territory.
 */
import { makeClient, loginWs, joinChannel, registerOrLogin, SERVER_BASE, WOL_URL } from "../scripts/wolLib";

const territory = Number(process.env.WDT_TERRITORY ?? "14");

const token = await registerOrLogin(SERVER_BASE, "terrtest", "password123");
const client = makeClient(WOL_URL);
await client.open;
await loginWs(client, token);
await joinChannel(client, "#Lob 33 0", "zotclot9");
client.send(`wdtstart ${territory}`);
client.send("list 33 33");
const startg = await client.waitFor(line => line.includes(" STARTG "), "STARTG");
console.log("startg:", startg.trim());

const status = await (await fetch(`${SERVER_BASE}/wdt/status`)).json() as {
    conflicts: Array<{ territoryId: number; gameId: string; attacker: number }>;
};
const mine = status.conflicts.filter(c => startg.includes(c.gameId));
console.log("conflicts for this game:", JSON.stringify(mine));
client.close();
if (!mine.some(c => c.territoryId === territory)) {
    console.error(`expected territory ${territory}`);
    process.exit(1);
}
console.log("territory propagated OK");
