import { ServerConfig } from "../config";
import { Logger, makeLogger } from "../logger";
import { SessionManager } from "../auth/session";
import { AccountStore } from "../auth/accountStore";
import { ServerUser } from "./ServerUser";
import { Channel } from "./Channel";
import { GameChannel } from "./GameChannel";
import { PartyManager } from "./PartyManager";
import { MatchmakingBot } from "../matchmaking/MatchmakingBot";
import { GservManager } from "../gserv/GservManager";
import { escapeChannelName, unescapeChannelName } from "../protocol/lineCodec";
import { isValidChannelKey, isValidNickChars, stripCrlf } from "../protocol/validate";
import { numeric, userLine, userPrefix, WOL_SERVER_NAME } from "../protocol/replies";
import { SocketLike } from "./SocketLike";
import * as Code from "../protocol/wolCodes";

const LOCALE_CODE_BY_ID: Record<number, string> = {
    2: "en-US",
    3: "en-CA",
    4: "en-GB",
    5: "de-DE",
    6: "fr-FR",
    7: "es-ES",
    8: "nl-NL",
    10: "de-AT",
    11: "de-CH",
    12: "it-IT",
    14: "sv-SE",
    19: "ja-JP",
    20: "ko-KR",
    21: "zh-CN",
    22: "zh-SG",
    23: "zh-TW",
    24: "zh-MY",
    25: "en-AU",
    27: "pt-BR",
    28: "th-TH",
    33: "pl-PL",
    34: "pt-PT",
    36: "ru-RU",
};

export class WolServer {
    readonly serverName = WOL_SERVER_NAME;
    readonly users = new Map<string, ServerUser>();
    readonly channels = new Map<string, Channel>();
    readonly games = new Map<string, GameChannel>();
    readonly parties = new PartyManager(this);
    readonly matchbot = new MatchmakingBot(this);
    readonly gservs: GservManager;
    readonly log: Logger;
    private pingInterval?: ReturnType<typeof setInterval>;
    private localeCodes = LOCALE_CODE_BY_ID;

    constructor(
        readonly config: ServerConfig,
        readonly sessions: SessionManager,
        readonly accounts: AccountStore,
        gservs: GservManager,
    ) {
        this.gservs = gservs;
        this.log = makeLogger(config.logLevel, "wol");
    }

    startPingLoop(): void {
        if (this.pingInterval) {
            return;
        }
        this.pingInterval = setInterval(() => this.pingAll(), this.config.pingIntervalSeconds * 1000);
    }

    stopPingLoop(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    private pingAll(): void {
        const now = Date.now();
        const timeoutMs = this.config.pingIntervalSeconds * 3 * 1000;
        for (const user of this.users.values()) {
            if (!user.authenticated || user.socket.readyState !== 1) {
                continue;
            }
            if (user.lastPingSent > 0 && now - user.lastPongAt > timeoutMs) {
                this.log.info(`closing ${user.nick}: no PONG for ${Math.round((now - user.lastPongAt) / 1000)}s`);
                user.socket.close(4009, "Ping timeout");
                continue;
            }
            user.lastPingSent = now;
            user.send(`PING ${now}\r\n`);
        }
    }

    dispose(): void {
        this.stopPingLoop();
        this.matchbot.dispose();
    }

    handleOpen(socket: SocketLike): ServerUser {
        return new ServerUser(socket);
    }

    handleClose(user: ServerUser): void {
        for (const key of [...user.channels]) {
            const channel = this.channels.get(key);
            if (channel) {
                this.removeMember(channel, user);
            }
            const game = this.games.get(key);
            if (game) {
                this.removeMember(game, user);
            }
        }
        if (user.nick) {
            if (user.partyId) {
                this.parties.leave(user);
            }
            this.matchbot.removeFromQueue(user);
            this.users.delete(user.nick);
            this.log.info(`disconnect ${user.nick} (ping ${user.ping})`);
        }
        else {
            this.log.debug(`disconnect (not authenticated)`);
        }
    }

    private static readonly MAX_LINES_PER_FRAME = 32;
    private static readonly MAX_LINE_LENGTH = 16 * 1024;

    handleMessage(user: ServerUser, message: string | Uint8Array): void {
        if (typeof message !== "string") {
            return;
        }
        let processed = 0;
        for (const line of message.split(/\r?\n/)) {
            if (processed >= WolServer.MAX_LINES_PER_FRAME) {
                this.log.warn(`dropping frame: too many lines from ${user.nick || "<anon>"}`);
                break;
            }
            processed += 1;
            if (line.length > WolServer.MAX_LINE_LENGTH) {
                this.log.warn(`dropping frame: line too long from ${user.nick || "<anon>"}`);
                break;
            }
            if (line.length && !user.rateBucket.tryTake()) {
                this.log.warn(`rate limit exceeded for ${user.nick || "<anon>"}; dropping connection`);
                user.socket.close(4008, "Rate limit exceeded");
                break;
            }
            if (line.length) {
                this.handleLine(user, line);
            }
        }
    }

    private handleLine(user: ServerUser, line: string): void {
        line = stripCrlf(line);
        const parts = line.split(" ");
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        switch (cmd) {
            case "ping": this.handlePing(user, args); break;
            case "pong": this.handlePong(user, args); break;
            case "cvers": this.handleCvers(user, args); break;
            case "setlocale": this.handleSetLocale(user, args); break;
            case "getlocale": this.handleGetLocale(user, args); break;
            case "session": this.handleSession(user, args); break;
            default: this.handleAuthedCommand(user, cmd, line, args); break;
        }
    }

    private handleAuthedCommand(user: ServerUser, cmd: string, line: string, args: string[]): void {
        if (!user.authenticated) {
            this.sendNumeric(user, Code.ERR_NOTREGISTERED, "*", [], "You must be logged in");
            return;
        }
        switch (cmd) {
            case "join": this.handleJoin(user, args); break;
            case "part": this.handlePart(user, args); break;
            case "names": this.handleNames(user, args); break;
            case "list": this.handleList(user, args); break;
            case "privmsg": this.handlePrivmsg(user, line); break;
            case "kick": this.handleKick(user, line, args); break;
            case "joingame": this.handleJoingame(user, args); break;
            case "gameopt": this.handleGameOpt(user, line); break;
            case "mode": this.handleMode(user, args); break;
            case "topic": this.handleTopic(user, line, args); break;
            case "gping": this.handleGping(user, args); break;
            case "startg": this.handleStartg(user, args); break;
            case "party_invite": this.parties.invite(user, args[0]); break;
            case "party_accept": this.parties.accept(user, args[0]); break;
            case "party_decline": this.parties.decline(user, args[0]); break;
            case "party_invite_unavailable": this.parties.inviteUnavailable(user, args[0]); break;
            case "party_leave": this.parties.leave(user); break;
            case "party_prevent": this.parties.prevent(user, args[0], args[1] === "1"); break;
            case "party_status": this.parties.status(user); break;
            case "party_noinvites": this.parties.noInvites(user, args[0] === "1"); break;
            default: this.sendNumeric(user, Code.ERR_UNKNOWNCOMMAND, user.nick, [cmd], "Unknown command"); break;
        }
    }

    private handlePing(user: ServerUser, args: string[]): void {
        const token = (args[0] ?? "").replace(/^:/, "");
        user.send(`:${this.serverName} PONG ${user.nick || "*"} :${token}\r\n`);
    }

    private handlePong(user: ServerUser, args: string[]): void {
        const sentAt = Number(args[0]);
        if (Number.isFinite(sentAt) && sentAt > 0) {
            user.ping = Math.max(0, Date.now() - sentAt);
        }
        user.lastPongAt = Date.now();
    }

    private handleCvers(user: ServerUser, args: string[]): void {
        user.version = args[0];
        user.sku = Number(args[1]);
        this.sendNumeric(user, Code.RPL_CVERS_OK, "*", [], "ok");
    }

    private handleSetLocale(user: ServerUser, args: string[]): void {
        user.locale = Number(args[0]);
        if (user.locale !== undefined) {
            user.localeCode = this.localeCodes[user.locale] ?? user.localeCode;
        }
        this.sendNumeric(user, Code.RPL_SET_LOCALE, "*", [], "ok");
    }

    private handleGetLocale(user: ServerUser, args: string[]): void {
        const nick = user.nick || "*";
        this.sendNumeric(user, Code.RPL_GET_LOCALE, nick, [nick], `0\`${user.localeCode}`);
    }

    private handleSession(user: ServerUser, args: string[]): void {
        const session = this.sessions.validate(args[0]);
        if (!session) {
            this.log.debug(`session rejected: invalid token`);
            this.sendNumeric(user, Code.RPL_BAD_SESSION, "*", [], "Invalid session token");
            return;
        }
        const nick = session.username;
        if (!isValidNickChars(nick)) {
            this.sessions.revoke(session.token);
            this.log.warn(`session rejected: username has invalid characters`);
            this.sendNumeric(user, Code.RPL_BAD_SESSION, "*", [], "Invalid session token");
            return;
        }
        if (this.accounts.get(nick)?.banned) {
            this.sessions.revoke(session.token);
            this.log.warn(`session rejected: ${nick} is banned`);
            this.sendNumeric(user, Code.RPL_BAD_SESSION, "*", [], "Account is banned");
            return;
        }
        const existing = this.users.get(nick);
        if (existing && existing !== user) {
            this.log.warn(`duplicate login for ${nick}; dropping previous connection`);
            this.users.delete(nick);
            existing.socket.close();
        }
        user.nick = nick;
        user.authenticated = true;
        const account = this.accounts.get(nick);
        user.fresh = account ? this.accounts.isFresh(account) : false;
        this.users.set(nick, user);
        this.log.info(`login ${nick}${user.fresh ? " (fresh account)" : ""}`);
        this.sendNumeric(user, Code.RPL_MOTDSTART, nick, [], `- ${this.serverName} MOTD`);
        for (const line of this.config.motd) {
            this.sendNumeric(user, Code.RPL_MOTD, nick, [], `- ${line}`);
        }
        this.sendNumeric(user, Code.RPL_ENDOFMOTD, nick, [], "- End of /MOTD command.");
    }

    private handleJoin(user: ServerUser, args: string[]): void {
        const key = args[0];
        const password = args[1];
        if (!key) {
            this.sendNumeric(user, Code.ERR_NEEDMOREPARAMS, user.nick, [key ?? ""], "Not enough parameters");
            return;
        }
        if (!isValidChannelKey(key)) {
            return;
        }
        let channel = this.channels.get(key);
        if (!channel) {
            channel = this.createLobbyChannel(key);
        }
        if (channel.password !== undefined && channel.password !== password) {
            this.sendNumeric(user, Code.ERR_BADCHANNELKEY, user.nick, [key], "Cannot join channel (+k) - bad key");
            return;
        }
        if (channel.isFull()) {
            this.sendNumeric(user, Code.ERR_CHANNELISFULL, user.nick, [key], "Cannot join channel (+l) - channel is full");
            return;
        }
        this.addMember(channel, user, false);
    }

    private createLobbyChannel(key: string): Channel {
        const name = unescapeChannelName(key);
        const match = name.match(/^#Lob (\d+) 0$/);
        const channel = new Channel(
            key,
            name,
            match ? this.config.globalChannelPass : undefined,
            match ? Number(match[1]) : undefined,
        );
        this.channels.set(key, channel);
        return channel;
    }

    private handlePart(user: ServerUser, args: string[]): void {
        const key = args[0];
        const channel = this.channels.get(key) ?? this.games.get(key);
        if (!channel) {
            return;
        }
        this.removeMember(channel, user);
    }

    private handleNames(user: ServerUser, args: string[]): void {
        const key = args[0];
        const channel = this.channels.get(key) ?? this.games.get(key);
        if (!channel) {
            this.sendNumeric(user, Code.ERR_NOSUCHCHANNEL, user.nick, [key], "No such channel");
            return;
        }
        if (!channel.has(user.nick)) {
            this.sendNumeric(user, Code.ERR_NOTONCHANNEL, user.nick, [key], "You're not on that channel");
            return;
        }
        this.sendChannelNames(channel, user);
    }

    private handleList(user: ServerUser, args: string[]): void {
        const arg = args[0] ?? "";
        const numericFilter = Number(arg);
        const matching = [...this.games.values()].filter(game =>
            (Number.isFinite(numericFilter) && game.channelType === numericFilter) ||
            game.key === arg ||
            game.name === unescapeChannelName(arg));
        this.sendNumeric(user, Code.RPL_LISTSTART, user.nick, [arg], "Channel Users Name");
        for (const game of matching) {
            const human = game.members.size;
            const topic = game.topic ?? "";
            const modeCode = game.channelType;
            this.sendNumeric(user, Code.RPL_LIST, user.nick, [
                game.key,
                String(human),
                "0",
                game.tournament ? "1" : "0",
                "0",
                String(user.ping),
                "0",
                `${modeCode}::${topic}`,
            ]);
        }
        this.sendNumeric(user, Code.RPL_LISTEND, user.nick, [arg], "End of /LIST");
    }

    private handlePrivmsg(user: ServerUser, line: string): void {
        const sep = line.indexOf(" :");
        if (sep === -1) {
            return;
        }
        const targets = line.slice(7, sep).trim().split(",").map(t => t.trim()).filter(Boolean);
        const text = stripCrlf(line.slice(sep + 2));
        for (const target of targets) {
            if (target.startsWith("#")) {
                if (!isValidChannelKey(target)) {
                    continue;
                }
                const channel = this.channels.get(target) ?? this.games.get(target);
                if (!channel) {
                    continue;
                }
                this.broadcastChannel(channel, userLine(userPrefix(user.nick, user.hostmask), "PRIVMSG", `${target} :${text}`), user);
            }
            else if (target === this.config.matchBotName) {
                this.matchbot.handleMessage(user, text);
            }
            else {
                if (!isValidNickChars(target)) {
                    continue;
                }
                const targetUser = this.users.get(target);
                if (!targetUser) {
                    this.sendNumeric(user, Code.ERR_NOSUCHNICK, user.nick, [target], "No such nick");
                    continue;
                }
                targetUser.send(userLine(userPrefix(user.nick, user.hostmask), "PRIVMSG", `${target} :${text}`));
            }
        }
    }

    private handleKick(user: ServerUser, line: string, args: string[]): void {
        const sep = line.indexOf(" :");
        const key = args[0];
        const targets = (args[1] ?? "").split(",").filter(Boolean);
        const channel = this.channels.get(key) ?? this.games.get(key);
        if (!channel || !isValidChannelKey(key)) {
            return;
        }
        const member = channel.members.get(user.nick);
        if (!member || !member.operator) {
            this.sendNumeric(user, Code.ERR_CHANOPRIVSNEEDED, user.nick, [key], "You're not channel operator");
            return;
        }
        for (const target of targets) {
            if (!isValidNickChars(target)) {
                continue;
            }
            const targetMember = channel.members.get(target);
            if (!targetMember) {
                continue;
            }
            const kicked = targetMember.user;
            this.log.info(`kick ${target} from ${key} by ${user.nick}`);
            this.broadcastChannel(channel, userLine(userPrefix(user.nick, user.hostmask), "KICK", `${key} ${target}`));
            channel.removeMember(kicked);
            if (kicked.gameChannel === key) {
                kicked.gameChannel = undefined;
            }
            this.sendChannelNames(channel);
        }
        if (channel instanceof GameChannel) {
            this.checkGameHostLeft(channel);
        }
    }

    private handleJoingame(user: ServerUser, args: string[]): void {
        if (args.length < 2) {
            this.sendNumeric(user, Code.ERR_NEEDMOREPARAMS, user.nick, [], "Not enough parameters");
            return;
        }
        if (args.length >= 8) {
            this.createGame(user, args);
        }
        else {
            this.joinGame(user, args);
        }
    }

    private createGame(user: ServerUser, args: string[]): void {
        const key = args[0];
        if (!isValidChannelKey(key)) {
            return;
        }
        if (this.games.has(key)) {
            this.sendNumeric(user, Code.ERR_RATE_LIMIT_EXCEEDED, user.nick, [key], "You have created too many games");
            return;
        }
        for (const game of this.games.values()) {
            if (game.hostName === user.nick) {
                this.sendNumeric(user, Code.ERR_RATE_LIMIT_EXCEEDED, user.nick, [key], "You have created too many games");
                return;
            }
        }
        const mode = Number(args[1]);
        const slots = Number(args[2]);
        const channelType = Number(args[3]);
        const observe = args[4] === "1";
        const tournament = Number(args[6]) === 1;
        const password = args[8] ? args.slice(8).join(" ") : undefined;

        const game = new GameChannel(key, unescapeChannelName(key));
        game.hostName = user.nick;
        game.mode = mode;
        game.slots = slots;
        game.channelType = channelType;
        game.tournament = tournament;
        game.privateGame = password !== undefined;
        game.password = password;
        game.observable = !observe;
        this.games.set(key, game);
        game.addMember(user, true);
        user.gameChannel = key;
        this.log.info(`game created ${key} by ${user.nick} (slots ${slots}, mode ${mode}, channelType ${channelType}, tournament ${tournament ? 1 : 0})`);
        const flags = `0 0 0 0 0 ${user.ping} 0`;
        this.broadcastChannel(game, userLine(userPrefix(user.nick, user.hostmask), "JOINGAME", `${flags} :${key}`));
        this.sendChannelNames(game);
        this.announceGserv(game, user);
    }

    private joinGame(user: ServerUser, args: string[]): void {
        const key = args[0];
        const password = args[2];
        if (!isValidChannelKey(key)) {
            return;
        }
        const game = this.games.get(key);
        if (!game) {
            this.sendNumeric(user, Code.ERR_GAMEHASCLOSED, user.nick, [key], "Game has closed");
            return;
        }
        if (game.password !== undefined && game.password !== password) {
            this.sendNumeric(user, Code.ERR_BADCHANNELKEY, user.nick, [key], "Cannot join game (+k) - bad key");
            return;
        }
        if (game.isFull()) {
            this.sendNumeric(user, Code.ERR_CHANNELISFULL, user.nick, [key], "Cannot join game (+l) - game is full");
            return;
        }
        game.addMember(user, false);
        user.gameChannel = key;
        this.log.info(`join game ${key} as ${user.nick} (now ${game.members.size}/${game.slots} players)`);
        const flags = `0 0 0 0 0 ${user.ping} 0`;
        this.broadcastChannel(game, userLine(userPrefix(user.nick, user.hostmask), "JOINGAME", `${flags} :${key}`));
        this.sendChannelNames(game);
        this.announceGserv(game, user);
    }

    private handleGameOpt(user: ServerUser, line: string): void {
        const sep = line.indexOf(" :");
        if (sep === -1) {
            return;
        }
        const key = line.slice(8, sep).trim();
        const opt = stripCrlf(line.slice(sep + 2));
        let game = this.games.get(key);
        if (!game) {
            const targetUser = this.users.get(key);
            if (targetUser?.gameChannel) {
                game = this.games.get(targetUser.gameChannel);
            }
        }
        if (!game || !game.has(user.nick)) {
            return;
        }
        if (/^[-0-9]/.test(opt[0] ?? "")) {
            game.gameOpts = opt;
        }
        this.broadcastChannel(game, userLine(userPrefix(user.nick, user.hostmask), "GAMEOPT", `${key} :${opt}`), user);
    }

    private handleMode(user: ServerUser, args: string[]): void {
        const key = args[0];
        const channel = this.channels.get(key) ?? this.games.get(key);
        if (!channel) {
            return;
        }
        const member = channel.members.get(user.nick);
        if (!member || !member.operator) {
            return;
        }
        const modeArgs = args.slice(1).join(" ").trim();
        const match = args[1]?.match(/^\+l(\d+)$/);
        if (match) {
            channel.limit = Math.min(Number(match[1]), 128);
        }
        this.broadcastChannel(channel, userLine(userPrefix(user.nick, user.hostmask), "MODE", `${key} ${modeArgs}`));
    }

    private handleTopic(user: ServerUser, line: string, args: string[]): void {
        const sep = line.indexOf(" :");
        const key = args[0];
        const topic = sep !== -1 ? stripCrlf(line.slice(sep + 2)) : "";
        const game = this.games.get(key);
        if (!game || !game.has(user.nick)) {
            return;
        }
        game.topic = topic;
        this.broadcastChannel(game, userLine(userPrefix(user.nick, user.hostmask), "TOPIC", `${key} :${topic}`));
    }

    private handleGping(user: ServerUser, args: string[]): void {
        const game = this.games.get(args[0]);
        if (game && isValidNickChars(args[1]) && game.pings.size < 128) {
            game.pings.set(args[1], Number(args[2]));
        }
    }

    private handleStartg(user: ServerUser, args: string[]): void {
        const key = args[0];
        const game = this.games.get(key);
        if (!game) {
            return;
        }
        if (game.hostName !== user.nick) {
            this.sendNumeric(user, Code.ERR_CHANOPRIVSNEEDED, user.nick, [key], "You're not channel operator");
            return;
        }
        const players = (args[1] ?? "").split(",").filter(Boolean);
        if (players.some(player => !isValidNickChars(player) || !game.has(player))) {
            this.sendStartgAbort(user, key, 2);
            return;
        }
        const gserv = this.gservs.getDefault();
        if (!gserv) {
            this.sendStartgAbort(user, key, 1);
            return;
        }
        const instance = this.gservs.create(players, gserv.url);
        instance.gameopts = game.gameOpts;
        this.log.info(`game start ${key} by ${user.nick}: instance ${instance.gameId} for ${players.join(", ")}`);
        for (const nick of players) {
            const member = game.members.get(nick);
            const ticket = instance.tickets.get(nick);
            if (member && ticket) {
                member.user.send(`:${this.serverName} STARTG ${key} :${gserv.url} :${instance.gameId} ${instance.timestamp} ${ticket}\r\n`);
            }
        }
    }

    private sendStartgAbort(user: ServerUser, key: string, reason: number): void {
        user.send(`:${this.serverName} STARTG_ABORT ${key} :${reason}\r\n`);
    }

    private announceGserv(game: GameChannel, user: ServerUser): void {
        const gserv = this.gservs.getDefault();
        if (gserv) {
            user.send(`:${this.serverName} GSERV ${game.key} :${gserv.id} ${gserv.url}\r\n`);
        }
    }

    private addMember(channel: Channel, user: ServerUser, operator: boolean): void {
        if (channel.has(user.nick)) {
            return;
        }
        channel.addMember(user, operator);
        this.log.debug(`join channel ${channel.key} as ${user.nick}`);
        const flags = `${0},${user.ping},${operator ? 1 : 0},${user.fresh ? 1 : 0}`;
        this.broadcastChannel(channel, userLine(userPrefix(user.nick, user.hostmask), "JOIN", `:${flags} ${channel.key}`));
        this.sendChannelNames(channel);
    }

    private removeMember(channel: Channel, user: ServerUser): void {
        if (!channel.has(user.nick)) {
            return;
        }
        this.log.debug(`leave channel ${channel.key} as ${user.nick}`);
        this.broadcastChannel(channel, userLine(userPrefix(user.nick, user.hostmask), "PART", channel.key));
        channel.removeMember(user);
        if (user.gameChannel === channel.key) {
            user.gameChannel = undefined;
        }
        this.sendChannelNames(channel);
        if (channel instanceof GameChannel) {
            this.checkGameHostLeft(channel);
        }
        if (user.inQueue) {
            this.matchbot.removeFromQueue(user);
        }
    }

    private checkGameHostLeft(game: GameChannel): void {
        if (!game.members.has(game.hostName)) {
            this.games.delete(game.key);
            this.log.info(`game ${game.key} closed (host left)`);
        }
    }

    sendChannelNames(channel: Channel, target?: ServerUser): void {
        const entries = [...channel.members.values()]
            .map(member => (member.operator ? "@" : "") + member.user.nick + ",0," + member.user.ping + "," + (member.user.fresh ? 1 : 0));
        const line = entries.join(" ");
        const recipients = target ? [target] : [...channel.members.values()].map(member => member.user);
        for (const recipient of recipients) {
            this.sendNumeric(recipient, Code.RPL_NAMREPLY, recipient.nick, ["=", channel.key], line);
            this.sendNumeric(recipient, Code.RPL_ENDOFNAMES, recipient.nick, [channel.key], "End of /NAMES list.");
        }
    }

    broadcastChannel(channel: Channel, line: string, exclude?: ServerUser): void {
        for (const member of channel.members.values()) {
            if (member.user !== exclude) {
                member.user.send(line);
            }
        }
    }

    sendNumeric(user: ServerUser, code: number, target: string, extra: string[], trailing?: string): void {
        user.send(numeric(this.serverName, code, target, extra, trailing));
    }
}
