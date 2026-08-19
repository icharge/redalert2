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

    private handleMatch(user: ServerUser, tags: string[]): void {
        if (this.byNick.has(user.nick)) {
            this.reply(user, RPL_ALREADY_QUEUED);
            return;
        }
        const parsed = new Map<string, string>();
        for (const tag of tags) {
            const eq = tag.indexOf("=");
            if (eq !== -1) {
                parsed.set(tag.slice(0, eq), tag.slice(eq + 1));
            }
        }
        const version = parsed.get(TAG_VERSION);
        const ranked = parsed.get(TAG_RANKED) === "1";
        if (version && !this.versionOk(version, ranked)) {
            this.reply(user, RPL_BAD_VERS);
            return;
        }
        const expectedModHash = this.server.config.expectedModHash;
        if (expectedModHash !== undefined && parsed.get(TAG_MODHASH) !== expectedModHash) {
            this.reply(user, RPL_BAD_HASH);
            return;
        }
        const channelType = this.getUserQueueType(user);
        if (channelType === undefined) {
            this.reply(user, RPL_MODE_UNAVAIL);
            return;
        }
        const queue = this.queues.get(channelType) ?? [];
        if (queue.length >= 8) {
            this.reply(user, RPL_RATE_LIMITED);
            return;
        }
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
        this.gameCounter += 1;
        const name = `#matchbot's game ${this.gameCounter}`;
        const key = escapeChannelName(name);
        const game = new GameChannel(key, name);
        game.hostName = this.server.config.matchBotName;
        game.mode = 1;
        game.slots = players.length;
        game.channelType = 0;
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
        });
        instance.gameopts = this.buildDefaultGameOpts(a, b);
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
        const expected = this.server.config.gameVersion;
        if (!ranked) {
            // Unranked games only require the same protocol family (major.minor).
            return version.split(".").slice(0, 2).join(".") === expected.split(".").slice(0, 2).join(".");
        }
        // Ranked games pair clients on the exact same game version (major.minor
        // .patch) so both sides play identical game logic; the git-hash build
        // suffix is stripped ("0.83.4-abcde" == "0.83.4").
        return stripBuildSuffix(version) === stripBuildSuffix(expected);
    }

    // Builds the authoritative gameopts for a quick-match/ranked instance.
    // The two matched sides are pinned to team 0 and team 1 so a 1v1 plays as a
    // normal fight (each team has one member -> no pre-formed alliance) and a
    // 2v2 forms the expected two-man teams. lockAlliances=1 disables in-game
    // diplomacy so players can neither re-team nor betray their side.
    private buildDefaultGameOpts(a: QueueEntry, b: QueueEntry): string {
        const players = [...a.players, ...b.players];
        const teamOf = new Map<string, number>();
        for (const nick of a.players) {
            teamOf.set(nick, 0);
        }
        for (const nick of b.players) {
            teamOf.set(nick, 1);
        }
        const mapTitle = Buffer.from("Default Map", "utf16le").toString("base64");
        const playersPart = players.map((name, index) => `${name},0,0,${index},${teamOf.get(name) ?? 0},0,0,0`).join(",");
        const aiPart = new Array(8).fill("0,-1,-1,-1,-1").join(",");
        return `0,0,2,10000,100,0,0,1,1,0,1,0,${mapTitle},${players.length},1,1000,mpdefault,abc123,1,0,0,1,0,1:${playersPart}:@:${aiPart},`;
    }

    private reply(user: ServerUser, text: string): void {
        const bot = this.server.config.matchBotName;
        user.send(`:${bot}!${bot}@local PRIVMSG ${user.nick} :${text}\r\n`);
    }
}
