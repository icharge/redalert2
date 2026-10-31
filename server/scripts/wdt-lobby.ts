/**
 * Live WOL -> WDT assignment test.
 *
 * Two clients create/join a game, publish WDT game options (`WDS=0`, `WDT=11`)
 * and the host starts it. The lobby must turn that into a conflict on the
 * shared WdtService, visible from /wdt/status.
 *
 *   SERVER_URL=http://127.0.0.1:19092 WOL_URL=ws://127.0.0.1:19092 \
 *     bun run scripts/wdt-lobby.ts
 */
import { makeClient, loginWs, joinChannel, registerOrLogin, SERVER_BASE, WOL_URL } from "./wolLib";
import { escapeChannelName } from "../src/protocol/lineCodec";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
    if (ok) console.log(`  [ok]   ${name}`);
    else { failures += 1; console.log(`  [FAIL] ${name}${detail ? ` :: ${detail}` : ""}`); }
}

const aliceToken = await registerOrLogin(SERVER_BASE, "wdtAlice", "password123");
const bobToken = await registerOrLogin(SERVER_BASE, "wdtBob", "password123");
const alice = makeClient(WOL_URL);
const bob = makeClient(WOL_URL);
await Promise.all([alice.open, bob.open]);
await loginWs(alice, aliceToken);
await loginWs(bob, bobToken);

const lobby = escapeChannelName("#Lob 45 0");
await joinChannel(alice, "#Lob 45 0", "zotclot9");
await joinChannel(bob, "#Lob 45 0", "zotclot9");

const gameName = escapeChannelName("#wdt game");
alice.send(`joingame ${gameName} 1 9 45 0 0 0 0`);
await alice.waitFor(line => new RegExp(`JOINGAME [^:]+:${gameName}$`).test(line), "create game");
bob.send(`joingame ${gameName} 0`);
await bob.waitFor(line => new RegExp(`JOINGAME [^:]+:${gameName}$`).test(line), "join game");

const opts = `0,0,2,10000,100,0,0,1,1,0,1,0,bWFw,2,1,1000,mpdefault,abc123,1,0,0,1,0,1:alice,0,0,0,0,0,0,0,bob,0,0,1,1,0,0,0:@:0,-1,-1,-1,-1,,WDS=0,WDT=11`;
alice.send(`gameopt ${gameName} :${opts}`);
await bob.waitFor(line => line.includes("GAMEOPT"), "gameopt relay");

alice.send(`startg ${gameName} wdtAlice,wdtBob`);
const start = await alice.waitFor(line => line.includes(" STARTG ") && line.includes(gameName), "STARTG");
const gameId = / :(\S+) \d+ \S+$/.exec(start)?.[1] ?? "";
check("STARTG carries a game id", /^g\d+-/.test(gameId), start);

const status = await (await fetch(`${SERVER_BASE}/wdt/status`)).json() as {
    conflicts: Array<{ id: number; territoryId: number; gameId?: string; attacker: number }>;
};
const conflict = status.conflicts.find(c => c.gameId === gameId);
check("WOL STARTG created a WDT conflict", !!conflict, JSON.stringify(status.conflicts));
check("conflict targets the requested territory", conflict?.territoryId === 11, JSON.stringify(conflict));
check("conflict attacker is the requested side", conflict?.attacker === 0, JSON.stringify(conflict));

alice.close();
bob.close();
console.log(failures === 0 ? "\nWDT LOBBY TEST PASSED" : `\nWDT LOBBY TEST FAILED (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
