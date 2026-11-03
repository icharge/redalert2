/**
 * Two-account World Domination pairing check over real WebSocket WOL clients.
 * It sends the same `wdtarmed` / `wdtstart` / `Match` sequence the browser
 * bridge does and expects `Matched`, then STARTG on #WDTmatch for both.
 *
 *   bun run scripts/wdt-bot-check.ts
 */
import { makeClient, loginWs, joinChannel, registerOrLogin, SERVER_BASE, WOL_URL } from "./wolLib";

const alice = makeClient(WOL_URL);
const bob = makeClient(WOL_URL);
await Promise.all([alice.open, bob.open]);

const [aTok, bTok] = await Promise.all([
  registerOrLogin(SERVER_BASE, "wdtprb1", "wolpass1"),
  registerOrLogin(SERVER_BASE, "wdtprb2", "wolpass1"),
]);
await loginWs(alice, aTok);
await loginWs(bob, bTok);

alice.send("wdtarmed");
bob.send("wdtarmed");
alice.send("wdtstart 1");
bob.send("wdtstart 1");
await joinChannel(alice, "#Lob 35 0", "zotclot9");
await joinChannel(bob, "#Lob 35 0", "zotclot9");

const match = "Match COU=US,COL=0,VRS=0.83.4,RKD=0";
alice.send(`privmsg matchbot :${match}`);
bob.send(`privmsg matchbot :${match}`);

const aMatched = await alice.waitFor(l => l.includes(" PRIVMSG ") && l.includes("Matched"), "alice Matched");
const bMatched = await bob.waitFor(l => l.includes(" PRIVMSG ") && l.includes("Matched"), "bob Matched");
console.log("matched", aMatched, "|", bMatched);
await new Promise(resolve => setTimeout(resolve, 12000));
const aStart = await alice.waitFor(l => l.includes(" STARTG "), "alice STARTG");
const bStart = await bob.waitFor(l => l.includes(" STARTG "), "bob STARTG");
console.log("startg", aStart);
console.log("startg", bStart);
alice.close();
bob.close();
