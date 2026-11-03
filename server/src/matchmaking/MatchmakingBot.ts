import { ServerUser } from "../server/ServerUser";
import { WolServer } from "../server/WolServer";
import { GameChannel } from "../server/GameChannel";
import { Logger } from "../logger";
import { escapeChannelName } from "../protocol/lineCodec";
import {
    REQ_MATCH,
    REQ_STATS,
    REQ_LIST_QUEUES,
    RPL_WORKING,
    RPL_STATS,
    RPL_QUEUE_LIST,
    RPL_BAD_VERS,
    RPL_BAD_HASH,
    RPL_MODE_UNAVAIL,
    RPL_RATE_LIMITED,
    RPL_ALREADY_QUEUED,
    RPL_MATCHED,
    RPL_REQUEUE,
    TAG_COUNTRY,
    TAG_COLOR,
    TAG_RANKED,
    TAG_VERSION,
    TAG_MODHASH,
} from "../protocol/qmCodes";

interface QueueEntry {
    key: string;
    players: string[];
    channelType: number;
    ranked: boolean;
    /** True when the client is the retail (native) game, not the RA2Web app. */
    native?: boolean;
    /** WDT request that formed this queue entry, if any. */
    wdt?: { side: number; territory?: number };
    matched?: { gameKey: string; players: string[] };
}

const MATCH_COUNTDOWN_SECONDS = 10;

// Queue channel types map to ladder types: 50/60 are the RA2/Yuri 1v1 quick
// match channels, 51/61 the 2v2 channels (see WolConfig.allClientSettings).
function ladderTypeForChannelType(channelType: number): string | undefined {
    if (channelType === 50 || channelType === 60) {
        return "1v1";
    }
    if (channelType === 51 || channelType === 61) {
        return "2v2-random";
    }
    return undefined;
}

// "0.83.4-abc123" -> "0.83.4" (the vite-injected git hash build suffix is
// cosmetic and never part of the version contract).
function stripBuildSuffix(version: string): string {
    return version.split("-")[0];
}

// The retail client separates Match tags with ", " and leaves a trailing
// comma on every value except the last ("VRS=1.006, COL=...").
function parseQmTags(tags: string[]): Map<string, string> {
    const parsed = new Map<string, string>();
    for (const raw of tags) {
        const tag = raw.replace(/,+$/, "");
        const eq = tag.indexOf("=");
        if (eq !== -1) parsed.set(tag.slice(0, eq), tag.slice(eq + 1));
    }
    return parsed;
}

export class MatchmakingBot {
    private queues = new Map<number, QueueEntry[]>();
    private byNick = new Map<string, QueueEntry>();
    private gameCounter = 0;
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private log: Logger;

    constructor(private server: WolServer) {
        this.log = server.log;
    }

    handleMessage(user: ServerUser, text: string): void {
        const parts = text.split(" ");
        const cmd = parts[0];
        switch (cmd) {
            case REQ_MATCH:
                this.handleMatch(user, parts.slice(1));
                break;
            case "MatchWDT":
            case "WDT":
                this.handleWdtMatch(user, parts.slice(1));
                break;
            case REQ_STATS:
                this.handleStats(user);
                break;
            case REQ_LIST_QUEUES:
                this.handleListQueues(user);
                break;
            default:
                break;
        }
    }

    removeFromQueue(user: ServerUser): void {
        const entry = this.byNick.get(user.nick);
        if (!entry) {
            return;
        }
        this.log.info(`queue ${user.nick} left`);
        if (entry.matched) {
            this.cancelMatch(entry.matched);
        }
        else {
            const queue = this.queues.get(entry.channelType);
            if (queue) {
                const index = queue.indexOf(entry);
                if (index !== -1) {
                    queue.splice(index, 1);
                }
            }
        }
        this.clearEntry(entry);
    }

    dispose(): void {
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    private handleWdtMatch(user: ServerUser, tags: string[]): void {
        if (!this.server.wdt) {
            this.reply(user, RPL_MODE_UNAVAIL);
            return;
        }
        const parsed = parseQmTags(tags);
        const side = Number(parsed.get("WDS") ?? 0);
        if (!Number.isInteger(side) || side < 0) {
            this.reply(user, RPL_BAD_VERS);
            return;
        }
        const territory = parsed.get("WDT") !== undefined ? Number(parsed.get("WDT")) : undefined;
        if (territory !== undefined && (!Number.isInteger(territory) || territory < 0)) {
            this.reply(user, RPL_BAD_VERS);
            return;
        }
        this.handleMatch(user, tags.filter(tag => !tag.startsWith("WDS=") && !tag.startsWith("WDT=")), { side, territory });
    }

    private handleMatch(user: ServerUser, tags: string[], wdt?: { side: number; territory?: number }): void {
        if (this.byNick.has(user.nick)) {
            this.reply(user, RPL_ALREADY_QUEUED);
            return;
        }
        const parsed = parseQmTags(tags);
        // The browser WDT worker sends a plain `Match`; it has already joined
        // the WDT matching lobby (Lob_35_0/Lob_38_0), and the territory comes
        // from the earlier `wdtstart` when the click has been processed.
        const channelType = this.getUserQueueType(user);
        if (channelType === undefined) {
            this.reply(user, RPL_MODE_UNAVAIL);
            return;
        }
        const wdtQueue = channelType === 35 || channelType === 38;
        const context = wdt ?? (wdtQueue ? this.server.wdtMatchContext(user.nick) : undefined);
        const version = parsed.get(TAG_VERSION);
        const ranked = parsed.get(TAG_RANKED) === "1";
        if (version && !wdtQueue && !context && !this.versionOk(version, ranked)) {
            this.log.info(`match version rejected for ${user.nick}: ${version} (expected ${this.server.config.gameVersion})`);
            this.reply(user, RPL_BAD_VERS);
            return;
        }
        const expectedModHash = this.server.config.expectedModHash;
        if (expectedModHash !== undefined && parsed.get(TAG_MODHASH) !== expectedModHash) {
            this.reply(user, RPL_BAD_HASH);
            return;
        }
        const queue = this.queues.get(channelType) ?? [];
        if (queue.length >= 8) {
            this.reply(user, RPL_RATE_LIMITED);
            return;
        }
        const native = this.isNativeVersion(version);
        this.log.info(`queue ${user.nick} (channelType ${channelType}, ranked ${ranked ? 1 : 0})`);

        const party = this.server.parties.getParty(user);
        if (party) {
            this.server.parties.setReady(user, true);
            if (!(party.ready[0] && party.ready[1])) {
                this.reply(user, RPL_WORKING);
                return;
            }
            this.server.parties.setQueued(user, true);
            const entry: QueueEntry = {
                key: party.id,
                players: [...party.members],
                channelType,
                ranked: parsed.get(TAG_RANKED) === "1",
                native,
                wdt: context,
            };
            for (const nick of entry.players) {
                const member = this.server.users.get(nick);
                if (member) {
                    member.inQueue = true;
                    this.byNick.set(nick, entry);
                    this.reply(member, RPL_WORKING);
                }
            }
            queue.push(entry);
            this.queues.set(channelType, queue);
            this.tryMatch(channelType);
            return;
        }

        const entry: QueueEntry = {
            key: user.nick,
            players: [user.nick],
            channelType,
            ranked: parsed.get(TAG_RANKED) === "1",
            native,
            wdt: context,
        };
        user.inQueue = true;
        this.byNick.set(user.nick, entry);
        this.reply(user, RPL_WORKING);
        queue.push(entry);
        this.queues.set(channelType, queue);
        this.tryMatch(channelType);
    }

    private handleStats(user: ServerUser): void {
        const channelType = this.getUserQueueType(user);
        const count = channelType !== undefined ? (this.queues.get(channelType)?.length ?? 0) : 0;
        this.reply(user, `${RPL_STATS} ${count},-1`);
    }

    private handleListQueues(user: ServerUser): void {
        this.reply(user, RPL_QUEUE_LIST);
    }

    private tryMatch(channelType: number): void {
        const queue = this.queues.get(channelType);
        if (!queue || queue.length < 2) {
            return;
        }
        const a = queue.shift()!;
        const b = queue.shift()!;
        this.startMatch(a, b);
    }

    private startMatch(a: QueueEntry, b: QueueEntry): void {
        const players = [...a.players, ...b.players];
        this.log.info(`match found: ${players.join(", ")}`);
        for (const nick of players) {
            const user = this.server.users.get(nick);
            if (user) {
                this.reply(user, `${RPL_MATCHED} ${MATCH_COUNTDOWN_SECONDS}`);
            }
        }
        let wdt = a.wdt ?? b.wdt;
        this.gameCounter += 1;
        const name = wdt ? "#WDTmatch" : `#matchbot's game ${this.gameCounter}`;
        const key = escapeChannelName(name);
        const game = new GameChannel(key, name);
        game.hostName = this.server.config.matchBotName;
        game.mode = 1;
        game.slots = players.length;
        game.channelType = wdt ? 33 : 0;
        this.server.games.set(key, game);
        for (const nick of players) {
            const user = this.server.users.get(nick);
            if (!user) {
                continue;
            }
            game.addMember(user, false);
            user.gameChannel = key;
            user.send(`:${this.server.config.matchBotName}!${this.server.config.matchBotName}@local JOINGAME 0 0 0 0 0 ${user.ping} 0 :${key}\r\n`);
        }
        this.server.sendChannelNames(game);

        const gserv = this.server.gservs.getDefault();
        if (!gserv) {
            for (const nick of players) {
                const user = this.server.users.get(nick);
                if (user) {
                    this.reply(user, RPL_REQUEUE);
                }
            }
            return;
        }
        const instance = this.server.gservs.create(players, gserv.url, {
            ranked: a.ranked && b.ranked,
            ladderType: ladderTypeForChannelType(a.channelType),
            nativeSku: wdt ? 16640 : undefined,
        });
        if (wdt) {
            for (const nick of players) this.server.clearWdtPending(nick);
        }
        if (wdt && this.server.wdt) {
            try {
                const conflict = this.server.wdt.assignConflictOrAuto(wdt.side, wdt.territory, instance.gameId);
                if (wdt.territory !== undefined && conflict.territoryId !== wdt.territory) {
                    this.log.warn(`wdt territory ${wdt.territory} not attackable; using ${conflict.territoryId}`);
                }
                instance.wdtConflictId = conflict.id;
                instance.wdtSides = Object.fromEntries([
                    ...a.players.map(nick => [nick, conflict.attacker] as const),
                    ...b.players.map(nick => [nick, conflict.defender] as const),
                ]);
                this.log.info(`wdt conflict ${conflict.id} for territory ${conflict.territoryId} (game ${instance.gameId})`);
                // The gameopts must carry the territory the conflict actually
                // plays for, not the client's unusable click.
                wdt = { side: wdt.side, territory: conflict.territoryId };
            }
            catch (error) {
                this.log.warn(`wdt assignment failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        instance.gameopts = this.buildDefaultGameOpts(a, b, wdt);
        // The matchbot is the game host, so it has to answer the clients'
        // GameOptions request itself: the native client reads map/teams from
        // the cached GAMEOPT before OnGameStart, and without it the match
        // aborts as soon as it starts. Sent here so it precedes STARTG (sent on
        // the countdown below).
        game.gameOpts = instance.gameopts;
        this.server.broadcastChannel(
            game,
            `:${this.server.config.matchBotName}!${this.server.config.matchBotName}@local GAMEOPT ${key} :${instance.gameopts}\r\n`,
        );
        this.log.info(`gameopts sent for match ${key}`);
        this.log.info(`instance ${instance.gameId} created${a.ranked && b.ranked ? ` (ranked ${instance.ladderType})` : ""} for ${players.join(", ")}`);

        const matched = { gameKey: key, players };
        for (const entry of [a, b]) {
            for (const nick of entry.players) {
                const byNick = this.byNick.get(nick);
                if (byNick) {
                    byNick.matched = matched;
                }
            }
        }
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.log.info(`STARTG sent for match ${key} (${players.join(", ")})`);
            for (const nick of players) {
                const user = this.server.users.get(nick);
                const ticket = instance.tickets.get(nick);
                if (user && ticket) {
                    user.send(`:${this.server.serverName} STARTG ${key} :${gserv.url} :${instance.gameId} ${instance.timestamp} ${ticket}\r\n`);
                }
            }
        }, MATCH_COUNTDOWN_SECONDS * 1000);
        this.timers.add(timer);
    }

    private cancelMatch(matched: { gameKey: string; players: string[] }): void {
        this.server.games.delete(matched.gameKey);
        for (const nick of matched.players) {
            this.byNick.delete(nick);
            const user = this.server.users.get(nick);
            if (user) {
                user.inQueue = false;
                user.gameChannel = undefined;
                this.server.parties.setQueued(user, false);
                this.reply(user, RPL_REQUEUE);
            }
        }
    }

    private clearEntry(entry: QueueEntry): void {
        for (const nick of entry.players) {
            this.byNick.delete(nick);
            const user = this.server.users.get(nick);
            if (user) {
                user.inQueue = false;
                this.server.parties.setQueued(user, false);
            }
        }
    }

    private getUserQueueType(user: ServerUser): number | undefined {
        for (const key of user.channels) {
            const match = key.match(/^#Lob_(\d+)_0$/);
            if (match) {
                return Number(match[1]);
            }
        }
        return undefined;
    }

    private versionOk(version: string, ranked: boolean): boolean {
        const webVersion = this.server.config.gameVersion;
        const nativeVersion = this.server.config.nativeGameVersion;
        if (!ranked) {
            // Unranked games only require the same protocol family
            // (major.minor): the browser ladder client reports 0.83.x and the
            // retail game reports its own 1.006.
            const family = (value: string) => value.split(".").slice(0, 2).join(".");
            return family(version) === family(webVersion) || family(version) === family(nativeVersion);
        }
        // Ranked games pair clients on the exact same game version (major.minor
        // .patch) so both sides play identical game logic; the git-hash build
        // suffix is stripped ("0.83.4-abcde" == "0.83.4").
        return stripBuildSuffix(version) === stripBuildSuffix(webVersion);
    }

    /** The retail game reports its own VRS (1.006) instead of RA2Web's 0.83.x. */
    private isNativeVersion(version: string | undefined): boolean {
        if (!version) return false;
        const family = (value: string) => value.split(".").slice(0, 2).join(".");
        return family(version) === family(this.server.config.nativeGameVersion);
    }

    // Builds the authoritative gameopts for a quick-match/ranked instance.
    // The two matched sides are pinned to team 0 and team 1 so a 1v1 plays as a
    // normal fight (each team has one member -> no pre-formed alliance) and a
    // 2v2 forms the expected two-man teams. lockAlliances=1 disables in-game
    // diplomacy so players can neither re-team nor betray their side.
    private buildDefaultGameOpts(a: QueueEntry, b: QueueEntry, wdt?: { side: number; territory?: number }): string {
        const players = [...a.players, ...b.players];
        const teamOf = new Map<string, number>();
        for (const nick of a.players) {
            teamOf.set(nick, 0);
        }
        for (const nick of b.players) {
            teamOf.set(nick, 1);
        }
        const mapTitleText = a.native || b.native ? "Random Map" : "Default Map";
        // The retail client resolves RandMap.Map to its built-in random map
        // generator; "mpdefault" only exists in the RA2Web map set.
        const mapName = a.native || b.native ? "RandMap.Map" : "mpdefault";
        const mapTitle = Buffer.from(mapTitleText, "utf16le").toString("base64");
        const playersPart = players.map((name, index) => `${name},0,0,${index},${teamOf.get(name) ?? 0},0,0,0`).join(",");
        const aiPart = new Array(8).fill("0,-1,-1,-1,-1").join(",");
        const wdtPart = wdt ? `,WDS=${wdt.side}${wdt.territory !== undefined ? `,WDT=${wdt.territory}` : ""}` : "";
        return `0,0,2,10000,100,0,0,1,1,0,1,0,${mapTitle},${players.length},1,1000,${mapName},abc123,1,0,0,1,0,1:${playersPart}:@:${aiPart},${wdtPart}`;
    }

    private reply(user: ServerUser, text: string): void {
        const bot = this.server.config.matchBotName;
        user.send(`:${bot}!${bot}@local PRIVMSG ${user.nick} :${text}\r\n`);
    }
}
