/**
 * Two-player real WebSocket test for the RA2Web WOL server.
 *
 * Validates the full multiplayer lobby flow over actual sockets:
 *   A creates a game, B joins it, chat + gameopt relay both ways,
 *   host starts the game and both players receive the gserv handoff.
 *
 * Usage:
 *   bun run scripts/wol-two-player.ts
 */
import { makeClient, loginWs, joinChannel, registerOrLogin, SERVER_BASE, WOL_URL } from "./wolLib";
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

async function main(): Promise<void> {
    const aliceToken = await registerOrLogin(SERVER_BASE, "alice", "password123");
    const bobToken = await registerOrLogin(SERVER_BASE, "bob", "password123");
    const alice = makeClient(WOL_URL);
    const bob = makeClient(WOL_URL);
    await Promise.all([alice.open, bob.open]);
    await loginWs(alice, aliceToken);
    await loginWs(bob, bobToken);

    const lobby = escapeChannelName("#Lob 45 0");
    await joinChannel(alice, "#Lob 45 0", "zotclot9");
    await joinChannel(bob, "#Lob 45 0", "zotclot9");
    check("both players joined the lobby", true);

    // channel chat relay (whisper-ish: alice -> channel, bob must not see alice's own echo)
    alice.send(`privmsg ${lobby} :hello all`);
    const bobSees = await bob.waitFor(line => /PRIVMSG #Lob_45_0 :hello all$/.test(line), "bob sees channel chat");
    check("chat relayed from alice to bob", /:alice!local PRIVMSG #Lob_45_0 :hello all$/.test(bobSees), bobSees);

    const gameName = escapeChannelName("#alice's game");
    alice.send(`joingame ${gameName} 1 9 45 0 0 0 0`);
    await alice.waitFor(line => new RegExp(`JOINGAME [^:]+:${gameName}$`).test(line), "alice creates game");

    bob.send(`joingame ${gameName} 0`);
    await bob.waitFor(line => new RegExp(`JOINGAME [^:]+:${gameName}$`).test(line), "bob joins game");
    await alice.waitFor(line => new RegExp(`353 alice = ${gameName} :@alice,\\d+,0,\\d+ bob,\\d+,0,\\d+`).test(line), "alice sees bob in NAMES");
    check("bob joined alice's game", true);

    // gameopt relay (host -> joiner, not echoed back to host)
    alice.send(`gameopt ${gameName} :L@Open@,alice,bob`);
    const bobOpt = await bob.waitFor(line => /GAMEOPT #alice's_game :L@Open@,alice,bob$/.test(line), "bob receives gameopt");
    check("gameopt relayed host -> joiner", /:alice!local GAMEOPT #alice's_game :L@Open@,alice,bob$/.test(bobOpt), bobOpt);
    check("gameopt not echoed to host", !(await hasLineLater(alice, /GAMEOPT #alice's_game :L@Open@,alice,bob$/, 300)));

    // joiner -> host chat whisper
    bob.send(`privmsg ${gameName} :gl hf`);
    const aliceSees = await alice.waitFor(line => /PRIVMSG #alice's_game :gl hf$/.test(line), "alice sees joiner chat");
    check("chat relayed from bob to alice", /:bob!local PRIVMSG #alice's_game :gl hf$/.test(aliceSees), aliceSees);

    // host starts the game -> both get STARTG with distinct tickets
    alice.send(`startg ${gameName} alice,bob`);
    const aliceStart = await alice.waitFor(line => line.includes(" STARTG ") && line.includes(gameName), "alice STARTG");
    const bobStart = await bob.waitFor(line => line.includes(" STARTG ") && line.includes(gameName), "bob STARTG");
    check("host receives gserv handoff", /STARTG .*:ws:\/\/\S+ :\S+ \d+ \S+$/.test(aliceStart), aliceStart);
    const ticketA = aliceStart.split(" ").pop()!;
    const ticketB = bobStart.split(" ").pop()!;
    check("joiner receives gserv handoff", ticketB.length === 32, bobStart);
    check("each player gets a unique ticket", ticketA !== ticketB);

    alice.send(`part ${gameName}`);
    await alice.waitFor(line => new RegExp(`PART ${gameName}$`).test(line), "alice parts game");
    await bob.waitFor(line => new RegExp(`PART ${gameName}$`).test(line), "bob sees alice part");
    alice.send(`part ${lobby}`);
    await alice.waitFor(line => new RegExp(`PART ${lobby}$`).test(line), "alice parts lobby");
    bob.send(`part ${lobby}`);
    await bob.waitFor(line => new RegExp(`PART ${lobby}$`).test(line), "bob parts lobby");

    alice.close();
    bob.close();
    console.log(failures === 0 ? "\nTWO-PLAYER TEST PASSED" : `\nTWO-PLAYER TEST FAILED (${failures} failures)`);
    process.exit(failures === 0 ? 0 : 1);
}

async function hasLineLater(client: ReturnType<typeof makeClient>, regex: RegExp, ms: number): Promise<boolean> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), ms);
        client.waitFor(line => regex.test(line), "negative-check").then(() => {
            clearTimeout(timer);
            resolve(true);
        }, () => resolve(false));
    });
}

main().catch(error => {
    console.error("TWO-PLAYER TEST ERROR:", error);
    process.exit(1);
});
