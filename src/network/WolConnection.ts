import { EventDispatcher } from "@/util/event";
import { IrcConnection, IrcRawReply } from "@/network/IrcConnection";
import { WolError } from "@/network/WolError";
import { isNotNullOrUndefined } from "@/util/typeGuard";
import { ChatRecipientType, ChatMessage } from "@/network/chat/ChatMessage";
import { Message } from "@/network/chat/Message";
import { SystemMessage } from "@/network/chat/SystemMessage";
import * as WolCode from "@/network/wolCodes";
import { IrcProtocol } from "@/network/IrcProtocol";
import { WolLocale } from "@/network/WolLocale";
import { MATCH_BOT_NAME } from "@/network/WolConfig";
import { Parser } from "@/network/gameopt/Parser";
import { Serializer } from "@/network/gameopt/Serializer";
import { escape } from "@puzzl/core/lib/regexp";
import { WolGameReport } from "@/network/WolGameReport";

export enum WolHasMapStatus {
    NoMap = 0,
    HasMap = 1,
    MapTransfer = 2,
}

export interface WolChannelUser {
    name: string;
    operator: boolean;
    ping: number;
    fresh: boolean;
}

export interface WolGameInfo {
    hostName: string;
    hostPing: number;
    hostMuted: boolean;
    name: string;
    description: string;
    modHash: string;
    modName: string | undefined;
    tournament: boolean;
    humanPlayers: number;
    aiPlayers: number;
    maxPlayers: number;
    observers: number;
    observable: boolean;
    mapName: string;
    passLocked: boolean;
    resLocked: boolean;
}

export interface WolChannelEvent {
    type: "join" | "leave";
    user: {
        name: string;
        operator?: boolean;
        ping?: number;
        fresh?: boolean;
        observer?: boolean;
    };
    channel: string;
}

export interface WolGameStartEvent {
    gameId: string;
    timestamp: number;
    gservUrl: string;
    ticket: string;
}

export interface WolGameStartAbortEvent {
    reason: number;
}

export interface WolLoginQueueEvent {
    position: number;
    avgWaitSeconds: number;
}

export class WolConnection {
    private currentUser?: string;
    private serverName?: string;
    private currentGameChannel?: string;
    private currentChannels: Set<string> = new Set();
    private lastChannelOpts: Map<string, string | undefined> = new Map();
    private pendingChannelUsers: Map<string, WolChannelUser[]> = new Map();
    private _onLoginQueueUpdate = new EventDispatcher<WolConnection, WolLoginQueueEvent>();
    private _onChatMessage = new EventDispatcher<WolConnection, ChatMessage | Message | SystemMessage>();
    private _onJoinChannel = new EventDispatcher<WolConnection, WolChannelEvent>();
    private _onJoinGameChannel = new EventDispatcher<WolConnection, WolChannelEvent>();
    private _onLeaveChannel = new EventDispatcher<WolConnection, WolChannelEvent>();
    private _onGameStart = new EventDispatcher<WolConnection, WolGameStartEvent>();
    private _onGameStartAbort = new EventDispatcher<WolConnection, WolGameStartAbortEvent>();
    private _onGameOpt = new EventDispatcher<WolConnection, { user: string; opt: string }>();
    private _onGameMode = new EventDispatcher<WolConnection, number>();
    private _onGameServer = new EventDispatcher<WolConnection, { id: string; url: string }>();
    private _onChannelUsers = new EventDispatcher<WolConnection, { channelName: string; users: WolChannelUser[] }>();
    private _onGameReport = new EventDispatcher<WolConnection, WolGameReport>();
    private _onPartyUpdate = new EventDispatcher<WolConnection, string>();

    get onError() {
        return this.con.onError;
    }
    get onClose() {
        return this.con.onClose;
    }
    get onLoginQueueUpdate() {
        return this._onLoginQueueUpdate.asEvent();
    }
    get onChatMessage() {
        return this._onChatMessage.asEvent();
    }
    get onJoinChannel() {
        return this._onJoinChannel.asEvent();
    }
    get onJoinGameChannel() {
        return this._onJoinGameChannel.asEvent();
    }
    get onLeaveChannel() {
        return this._onLeaveChannel.asEvent();
    }
    get onGameStart() {
        return this._onGameStart.asEvent();
    }
    get onGameStartAbort() {
        return this._onGameStartAbort.asEvent();
    }
    get onGameOpt() {
        return this._onGameOpt.asEvent();
    }
    get onGameMode() {
        return this._onGameMode.asEvent();
    }
    get onGameServer() {
        return this._onGameServer.asEvent();
    }
    get onChannelUsers() {
        return this._onChannelUsers.asEvent();
    }
    get onGameReport() {
        return this._onGameReport.asEvent();
    }
    get onPartyUpdate() {
        return this._onPartyUpdate.asEvent();
    }

    static factory(logger: any): WolConnection {
        return new this(new IrcConnection({
            mode: "text",
            logFilter: (message) => message
                .replace(/((^|\n)session) ([^ \n]+)/gi, "$1 <redacted>")
                .replace(/^(join [^ ]+) ([^ ]+)/gi, "$1 <redacted>")
                .replace(/^(joingame (([^ ]+ ){2}|([^ ]+ ){8}))([^ ]+)$/gi, "$1<redacted>")
                .replace(/^(.* startg [^:]+:[^ ]+ :[^ ]+ \d+) [^ \r\n]+/gim, "$1 <redacted>")
                .replace(/^((privmsg|page|notice) ([^ ]+ )+):(.+)\r?\n?$/i, (match, prefix, _type, rest, _text) =>
                    rest === MATCH_BOT_NAME + " " ? match : prefix + ":<redacted>")
                .replace(/^(:([^ ]+) (privmsg|page|notice) ([^ ]+ )+):(.+)\r?\n?$/i, (match, prefix, nick) =>
                    nick.startsWith(MATCH_BOT_NAME + "!") ? match : prefix + ":<redacted>"),
        }, logger), logger);
    }

    constructor(private con: IrcConnection, private logger: any) {
        this.handleMessage = (message: any) => {
            if (typeof message === "string") {
                const parts = message.split(" ");
                const command = parts[0]?.toLowerCase();
                if (command === "ping") {
                    this.con.sendMessage("PONG" + (parts[1] ? " " + parts[1] : ""));
                }
                else if (parts[1]?.toLowerCase() === "privmsg") {
                    this.handlePrivMsg(message);
                }
                else if (parts[1]?.toLowerCase() === "page" || parts[1]?.toLowerCase() === "notice") {
                    this.handlePageOrNotice(message);
                }
                else if (parts[1]?.toLowerCase() === "join") {
                    this.handleJoin(message);
                }
                else if (parts[1]?.toLowerCase() === "joingame") {
                    this.handleJoingame(message);
                }
                else if (parts[1]?.toLowerCase() === "part") {
                    this.handlePart(message);
                }
                else if (parts[1]?.toLowerCase() === "kick") {
                    this.handleKick(message);
                }
                else if (parts[1]?.toLowerCase() === "gameopt") {
                    this.handleGameOpt(message);
                }
                else if (parts[1]?.toLowerCase() === "mode") {
                    this.handleMode(message);
                }
                else if (parts[1]?.toLowerCase() === "startg") {
                    this.handleStartGame(message);
                }
                else if (parts[1]?.toLowerCase() === "startg_abort") {
                    this.handleStartGameAbort(message);
                }
                else if (parts[1]?.toLowerCase() === "gserv") {
                    this.handleGserv(message);
                }
                else {
                    const code = Number(parts[1]);
                    if (!Number.isNaN(code)) {
                        const reply: IrcRawReply = {
                            raw: message,
                            code,
                            params: parts.slice(2),
                            time: Date.now(),
                        };
                        if (code === WolCode.RPL_LOGIN_QUEUE) {
                            this.handleLoginQueueUpdate(reply);
                        }
                        else if (code === WolCode.RPL_NAMREPLY) {
                            this.handleNamReply(reply);
                        }
                        else if (code === WolCode.RPL_ENDOFNAMES) {
                            this.handleEndOfNames(reply);
                        }
                        else if (code === WolCode.RPL_GAME_REPORT) {
                            this.handleGameReport(reply);
                        }
                        else if (code === WolCode.RPL_PARTY_UPDATE) {
                            this.handlePartyUpdate(message);
                        }
                        else {
                            this.handleIrcError(message);
                        }
                    }
                }
            }
        };
        this.handleClose = () => {
            this.currentUser = undefined;
            this.currentGameChannel = undefined;
            this.currentChannels.clear();
            this.pendingChannelUsers.clear();
            this.con.onMessage.unsubscribe(this.handleMessage);
        };
    }

    private handleMessage: (message: any) => void;
    private handleClose: () => void;

    getCurrentUser(): string | undefined {
        return this.currentUser;
    }

    getCurrentChannels(): string[] {
        return [...this.currentChannels];
    }

    isInChannel(channel: string): boolean {
        return this.currentChannels.has(channel);
    }

    getServerName(): string | undefined {
        return this.serverName;
    }

    async connect(url: string, options?: any): Promise<void> {
        this.con.onMessage.subscribe(this.handleMessage);
        this.con.onClose.subscribeOnce(this.handleClose);
        await this.con.connect(url, options);
    }

    close(): void {
        this.con.onMessage.unsubscribe(this.handleMessage);
        this.con.close();
    }

    isOpen(): boolean {
        return this.con.isOpen();
    }

    ping(timeoutSeconds: number): Promise<number> {
        return this.con.ping(timeoutSeconds);
    }

    async cvers(version: string, sku: number): Promise<void> {
        const replies = await this.con.sendCommand(`cvers ${version} ` + sku, {
            replyCodes: [WolCode.RPL_CVERS_OK, WolCode.RPL_CVERS_OUTDATED],
        });
        if (replies[0].code === WolCode.RPL_CVERS_OUTDATED) {
            const reason = replies[0].params ? replies[0].params.splice(1).join(" ").replace(/^:/, "") : "unknown";
            throw new WolError("Cvers error: " + reason, WolError.Code.OutdatedClient);
        }
    }

    async authenticate(sessionToken: string, onQueueUpdate?: (status: WolLoginQueueEvent) => void): Promise<string[]> {
        if (onQueueUpdate) {
            this._onLoginQueueUpdate.subscribe(onQueueUpdate);
        }
        const replies = await this.con.sendCommand("session " + sessionToken, {
            replyCodes: [WolCode.RPL_BAD_SESSION, WolCode.ERR_SERVER_FULL],
            replyStartCode: WolCode.RPL_MOTDSTART,
            replyBodyCodes: [WolCode.RPL_MOTD],
            replyEndCode: WolCode.RPL_ENDOFMOTD,
            replyHeartbeatCodes: [WolCode.RPL_LOGIN_QUEUE],
            heartbeatTimeout: Number.POSITIVE_INFINITY,
        }).finally(() => {
            if (onQueueUpdate) {
                this._onLoginQueueUpdate.unsubscribe(onQueueUpdate);
            }
        });
        if (replies.length === 1) {
            const reason = replies[0].params ? replies[0].params.splice(2).join(" ").replace(/^:/, "") : "unknown";
            if (replies[0].code === WolCode.RPL_BAD_SESSION) {
                throw new WolError("Login error: " + reason, WolError.Code.BadSession);
            }
            if (replies[0].code === WolCode.ERR_SERVER_FULL) {
                throw new WolError("Login error: " + reason, WolError.Code.ServerFull);
            }
        }
        const username = replies[0].params?.[0];
        if (!username) {
            throw new Error("Missing username");
        }
        this.currentUser = username;
        this.serverName = replies[0].raw.match(/^:([^\s]+)/)?.[1] || "";
        return replies.slice(0, -1).map(reply => reply.raw.replace(/^.*:- /, ""));
    }

    async setLocale(locale: number): Promise<void> {
        await this.con.sendCommand("setlocale " + locale, {
            replyCodes: [WolCode.RPL_SET_LOCALE],
        });
    }

    async getLocale(): Promise<WolLocale> {
        if (!this.currentUser) {
            throw new Error("Must login first");
        }
        const replies = await this.con.sendCommand("getlocale " + this.currentUser, {
            replyCodes: [WolCode.RPL_GET_LOCALE],
        });
        return (replies[0].params?.[2].split("`")[1] ?? WolLocale.Unknown) as WolLocale;
    }

    async joinChannel(channel: string, password?: string): Promise<void> {
        if (!this.currentUser) {
            throw new Error("Must login before sending messages");
        }
        const escapedChannel = IrcProtocol.escapeChannelName(channel);
        const command = "join " + escapedChannel + (password !== undefined ? " " + password : "");
        const replies = await this.con.sendCommand(command, {
            replyCodes: [
                [WolCode.ERR_NOSUCHCHANNEL, (reply) => !!reply.params && reply.params[1] === this.currentUser && reply.params[2] === escapedChannel],
                WolCode.ERR_BADCHANNELKEY,
                WolCode.ERR_CHANNELISFULL,
                WolCode.ERR_BANNEDFROMCHAN,
            ] as any,
            replyMatch: new RegExp(`^:${escape(this.currentUser)}![^ ]+ JOIN :[^ ]+ ${escape(escapedChannel)}$`, "i"),
        });
        if (replies[0].code !== undefined) {
            switch (replies[0].code) {
                case WolCode.ERR_NOSUCHCHANNEL:
                    throw new WolError("No such channel", WolError.Code.NoSuchChannel);
                case WolCode.ERR_BADCHANNELKEY:
                    throw new WolError("Wrong password", WolError.Code.BadChannelPass);
                case WolCode.ERR_CHANNELISFULL:
                    throw new WolError("Channel is full", WolError.Code.ChannelFull);
                case WolCode.ERR_BANNEDFROMCHAN:
                    throw new WolError("Banned from channel", WolError.Code.BannedFromChannel);
                default:
                    throw new Error("Unknown error");
            }
        }
        else {
            this.lastChannelOpts.set(channel, password);
        }
    }

    async listUsers(channel: string): Promise<WolChannelUser[]> {
        const replies = await this.con.sendCommand("NAMES " + IrcProtocol.escapeChannelName(channel), {
            replyCodes: [WolCode.ERR_NOSUCHCHANNEL, WolCode.ERR_NOTONCHANNEL],
            replyBodyCodes: [WolCode.RPL_NAMREPLY],
            replyEndCode: WolCode.RPL_ENDOFNAMES,
        });
        if (replies[0].code !== WolCode.RPL_NAMREPLY) {
            throw new Error("Unknown error");
        }
        return this.parseNames(replies.slice(0, -1)).sort((a, b) => Number(b.operator) - Number(a.operator));
    }

    async rejoinLastChannels(): Promise<void> {
        if (this.lastChannelOpts) {
            for (const [channel, password] of this.lastChannelOpts) {
                if (!this.isInChannel(channel)) {
                    await this.joinChannel(channel, password);
                }
            }
        }
    }

    sendChatMessage(text: string, recipient: { type: ChatRecipientType; name: string }): void {
        if (!this.currentUser) {
            throw new Error("Must login before sending messages");
        }
        if (recipient.type !== ChatRecipientType.Channel && recipient.type !== ChatRecipientType.Whisper) {
            return;
        }
        this.privmsg([recipient.name], text);
    }

    privmsg(recipients: string[], text: string): void {
        if (!this.currentUser) {
            throw new Error("Must login before sending messages");
        }
        const recipientList = recipients.map(recipient => recipient.startsWith("#") ? IrcProtocol.escapeChannelName(recipient) : recipient).join(",");
        this.con.sendMessage(`privmsg ${recipientList} :` + text);
        for (const recipient of recipients) {
            const isChannel = recipient.startsWith("#");
            this._onChatMessage.dispatch(this, {
                from: this.currentUser,
                to: {
                    type: isChannel ? ChatRecipientType.Channel : ChatRecipientType.Whisper,
                    name: recipient,
                },
                text,
                time: new Date(),
            });
        }
    }

    kick(users: string[], channel: string, reason?: string): void {
        this.con.sendMessage(`kick ${IrcProtocol.escapeChannelName(channel)} ${users.join(",")} :` + (reason || ""));
    }

    partyInvite(playerName: string): void {
        this.con.sendMessage("PARTY_INVITE " + playerName);
    }

    partyAccept(playerName: string): void {
        this.con.sendMessage("PARTY_ACCEPT " + playerName);
    }

    partyDecline(playerName: string): void {
        this.con.sendMessage("PARTY_DECLINE " + playerName);
    }

    partyInviteUnavailable(playerName: string): void {
        this.con.sendMessage("PARTY_INVITE_UNAVAILABLE " + playerName);
    }

    partyLeave(): void {
        this.con.sendMessage("PARTY_LEAVE");
    }

    partyPrevent(playerName: string, prevent: boolean): void {
        this.con.sendMessage(`PARTY_PREVENT ${playerName} ` + (prevent ? "1" : "0"));
    }

    partyStatus(): void {
        this.con.sendMessage("PARTY_STATUS");
    }

    partyNoInvites(enabled: boolean): void {
        this.con.sendMessage("PARTY_NOINVITES " + (enabled ? "1" : "0"));
    }

    async listGames(channel: string, mode: number): Promise<WolGameInfo[]> {
        if (!this.currentUser) {
            throw new Error("Must login before sending messages");
        }
        const replies = await this.con.sendCommand(`list ${channel} ` + channel, {
            replyStartCode: WolCode.RPL_LISTSTART,
            replyBodyCodes: [WolCode.RPL_LIST, WolCode.RPL_GAME_CHANNEL],
            replyEndCode: WolCode.RPL_LISTEND,
        });
        return replies.slice(1, -1).map((reply) => {
            if (!reply.params || reply.params.length < 10) {
                throw new Error(`Unexpected reply for list command "${reply.raw}". Insufficient params.`);
            }
            const channelName = IrcProtocol.unescapeChannelName(reply.params[1]);
            const humanPlayers = Number(reply.params[2]);
            const channelType = Number(reply.params[4]);
            const tournament = Number(reply.params[5]);
            const resLocked = reply.params[6];
            const hostPing = reply.params[7];
            const [modeCode, topicPart] = reply.params[8]?.split("::") ?? [];
            const hostMuted = reply.params[9];
            if (channelType !== mode && !topicPart) {
                return undefined;
            }
            if (modeCode === undefined || topicPart === undefined) {
                return undefined;
            }
            if (channelType !== mode) {
                return undefined;
            }
            const topic = new Parser().parseTopic(topicPart);
            if (!topic) {
                return undefined;
            }
            return {
                hostName: channelName.match(/^#?([^']+)'s game$/)?.[1] ?? "",
                hostPing: Number(hostPing),
                hostMuted: Boolean(Number(hostMuted)),
                name: channelName,
                description: topic.description,
                modHash: topic.modHash,
                modName: topic.modName,
                tournament: Boolean(Number(tournament)),
                humanPlayers: Number(humanPlayers),
                aiPlayers: topic.aiPlayers,
                maxPlayers: topic.maxPlayers,
                observers: topic.observers,
                observable: topic.observable,
                mapName: topic.mapName,
                passLocked: Number(modeCode) === 384,
                resLocked: Boolean(Number(resLocked)),
            };
        }).filter(isNotNullOrUndefined);
    }

    leaveChannel(channel: string): void {
        if (this.currentChannels.has(channel)) {
            this.lastChannelOpts.delete(channel);
            this.pendingChannelUsers.delete(channel);
            this.con.sendMessage("PART " + IrcProtocol.escapeChannelName(channel));
        }
    }

    leaveAllChannels(): void {
        for (const channel of this.getCurrentChannels()) {
            this.leaveChannel(channel);
        }
    }

    async createGame(name: string, mode: number, slots: number, mapHash: number, tournament: boolean, modHash?: string, privateGame: boolean = false): Promise<void> {
        if (!this.currentUser) {
            throw new Error("Must login before sending messages");
        }
        const escapedChannel = IrcProtocol.escapeChannelName(name);
        const replies = await this.con.sendCommand(`joingame ${escapedChannel} ${mode} ${slots} ${mapHash} ` +
            `${Number(privateGame)} 0 ${Number(tournament)} 0` + (modHash ? " " + modHash : ""), {
            replyCodes: [WolCode.ERR_RATE_LIMIT_EXCEEDED],
            replyMatch: new RegExp(`^:${escape(this.currentUser)}![^ ]+ JOINGAME [^:]+:${escape(escapedChannel)}$`, "i"),
        });
        if (replies[0].code === WolCode.ERR_RATE_LIMIT_EXCEEDED) {
            throw new WolError("Rate limit exceeded", WolError.Code.RateLimited);
        }
        this.logger.info(`Created game "${name}"`);
        this.currentChannels.add(name);
        this.currentGameChannel = name;
        this.logger.info(`Joined channel "${name}"`);
    }

    makeGameChannelName(): string {
        const name = this.getCurrentUser() + "'s game";
        const escaped = IrcProtocol.escapeChannelName("#" + name).slice(0, IrcProtocol.MAX_CHANNELNAME_LEN - 1);
        return IrcProtocol.unescapeChannelName(escaped);
    }

    async joinGame(channel: string, password?: string, tournament: boolean = false): Promise<void> {
        if (!this.currentUser) {
            throw new Error("Must login before sending messages");
        }
        const escapedChannel = IrcProtocol.escapeChannelName(channel);
        const replies = await this.con.sendCommand(`joingame ${escapedChannel} ${Number(tournament)} ` + (password || ""), {
            replyCodes: [
                WolCode.ERR_BADCHANNELKEY,
                WolCode.ERR_GAMEHASCLOSED,
                WolCode.ERR_CHANNELISFULL,
                WolCode.ERR_BANNEDFROMCHAN,
                WolCode.ERR_RATE_LIMIT_EXCEEDED,
            ],
            replyMatch: new RegExp(`^:${escape(this.currentUser)}![^ ]+ JOINGAME [^:]+:${escape(escapedChannel)}$`, "i"),
        });
        if (replies[0].code === undefined) {
            this.currentChannels.add(channel);
            this.currentGameChannel = channel;
            this.logger.info(`Joined channel "${channel}"`);
            return;
        }
        switch (replies[0].code) {
            case WolCode.ERR_BADCHANNELKEY:
                throw new WolError("Wrong password", WolError.Code.BadChannelPass);
            case WolCode.ERR_GAMEHASCLOSED:
                throw new WolError("Game has closed", WolError.Code.GameHasClosed);
            case WolCode.ERR_CHANNELISFULL:
                throw new WolError("Channel is full", WolError.Code.ChannelFull);
            case WolCode.ERR_BANNEDFROMCHAN:
                throw new WolError("Banned from channel", WolError.Code.BannedFromChannel);
            case WolCode.ERR_RATE_LIMIT_EXCEEDED:
                throw new WolError("Rate limit exceeded", WolError.Code.RateLimited);
            default:
                throw new Error("Unknown error");
        }
    }

    startGame(players: string[]): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        const playerList = players.join(",");
        this.con.sendMessage(`startg ${IrcProtocol.escapeChannelName(this.currentGameChannel)} ` + playerList);
    }

    private parseNames(replies: IrcRawReply[]): WolChannelUser[] {
        let users: WolChannelUser[] = [];
        replies.forEach(reply => {
            const parsed = this.parseNamReply(reply);
            users = users.concat(parsed);
        });
        return users;
    }

    private parseNamReply(reply: IrcRawReply): WolChannelUser[] {
        return reply.raw.replace(new RegExp("^.*(=|\\*) [^ ]+ :"), "").split(" ").map(name => name.split(",")).map(([name, , ping, fresh]) => {
            const isOperator = name.startsWith(WolConnection.CHAN_OP_PREFIX);
            return {
                name: isOperator ? name.slice(WolConnection.CHAN_OP_PREFIX.length) : name,
                operator: isOperator,
                fresh: Boolean(Number(fresh)),
                ping: Number(ping),
            };
        });
    }

    sendPlayerReady(ready: boolean): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(this.currentGameChannel, "A" + (ready ? 1 : 0));
    }

    sendPlayerHasMap(status: WolHasMapStatus): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(this.currentGameChannel, "K" + status);
    }

    sendGameStartRequest(): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(this.currentGameChannel, "G");
    }

    sendGameSlotsInfo(slotsInfo: any): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(this.currentGameChannel, "L" + slotsInfo);
    }

    sendPingData(pingData: string): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(this.currentGameChannel, "P" + pingData);
    }

    sendObserverSlot(slotData: string): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(this.currentGameChannel, "O" + slotData);
    }

    sendGameOpts(serializedOpts: string): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(this.currentGameChannel, serializedOpts);
    }

    sendPlayerOpts(channel: string, countryId: number, colorId: number, startPos: number, teamId: number): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        this.gameOpt(channel, `R${countryId},${colorId},${startPos},${teamId},0,0,0`);
    }

    sendModeChannelMax(channel: string, maxPlayers: number): void {
        this.con.sendMessage(`MODE ${IrcProtocol.escapeChannelName(channel)} +l ` + maxPlayers);
    }

    sendGameTopic(topic: any): void {
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        const escapedChannel = IrcProtocol.escapeChannelName(this.currentGameChannel);
        this.con.sendMessage(`topic ${escapedChannel} :` + new Serializer().serializeTopic(topic));
    }

    gameOpt(channel: string, opt: string): void {
        if (!this.currentUser) {
            throw new Error("Must login first");
        }
        if (!this.currentGameChannel) {
            throw new Error("No game channel active");
        }
        const escapedChannel = channel.startsWith("#") ? IrcProtocol.escapeChannelName(channel) : channel;
        this.con.sendMessage(`gameopt ${escapedChannel} :` + opt);
        this._onGameOpt.dispatch(this, {
            user: this.currentUser,
            opt,
        });
    }

    private handleJoin(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)![^ ]+ JOIN :([^ ]+) ([^ ]+)/i);
        if (!match) {
            throw new Error(`Unexpected JOIN message format "${message}"`);
        }
        const [, userName, flags, channelName] = match;
        const flagParts = flags.trim().split(",");
        const channel = IrcProtocol.unescapeChannelName(channelName);
        if (this.currentUser === userName) {
            this.currentChannels.add(channel);
            this.logger.info(`Joined channel "${channel}"`);
        }
        this._onJoinChannel.dispatch(this, {
            type: "join",
            user: {
                name: userName,
                ping: Number(flagParts[1]),
                operator: Boolean(Number(flagParts[2])),
                fresh: Boolean(Number(flagParts[3])),
            },
            channel,
        });
    }

    private handleJoingame(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)![^ ]+ JOINGAME ([^:]+):([^ ]+)/i);
        if (!match) {
            throw new Error(`Unexpected JOINGAME message format "${message}"`);
        }
        const [, userName, flags, channelName] = match;
        const flagParts = flags.trim().split(" ");
        const channel = IrcProtocol.unescapeChannelName(channelName);
        if (userName !== this.currentUser) {
            this.logger.info(`Player "${userName}" joined game "${channel}"`);
        }
        const event: WolChannelEvent = {
            type: "join",
            user: {
                name: userName,
                operator: false,
                ping: Number(flagParts[5]),
                observer: flagParts[7] !== undefined ? Boolean(Number(flagParts[7])) : undefined,
            },
            channel,
        };
        this._onJoinChannel.dispatch(this, event);
        this._onJoinGameChannel.dispatch(this, event);
    }

    private handleStartGame(message: string): void {
        const match = message.match(/^:[^ ]+ STARTG [^:]+:([^ ]+) :([^ ]+) (\d+) ([^ ]+)/i);
        if (!match) {
            throw new Error(`Unexpected STARTG message format "${message}"`);
        }
        const [, gservUrl, gameId, timestamp, ticket] = match;
        this._onGameStart.dispatch(this, {
            gameId,
            timestamp: Number(timestamp),
            gservUrl,
            ticket,
        });
    }

    private handleStartGameAbort(message: string): void {
        const match = message.match(/^:[^ ]+ STARTG_ABORT [^:]+:(\d+)/i);
        if (!match) {
            throw new Error(`Unexpected STARTG_ABORT message format "${message}"`);
        }
        this._onGameStartAbort.dispatch(this, {
            reason: Number(match[1]),
        });
    }

    private handleGserv(message: string): void {
        const match = message.match(/^[^ ]+ GSERV [^:]+:([^ ]+) ([^ ]+)/i);
        if (!match) {
            throw new Error(`Unexpected GSERV message format "${message}"`);
        }
        this._onGameServer.dispatch(this, {
            id: match[1],
            url: match[2],
        });
    }

    private handlePrivMsg(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)![^ ]+ PRIVMSG ([^ ]+) :(.*)/i);
        if (!match) {
            throw new Error(`Unexpected PRIVMSG message format "${message}"`);
        }
        const [, from, to, text] = match;
        const time = new Date();
        let chatMessage: ChatMessage | undefined;
        if (to.startsWith("#")) {
            chatMessage = {
                from,
                to: {
                    type: ChatRecipientType.Channel,
                    name: IrcProtocol.unescapeChannelName(to),
                },
                text,
                time,
            };
        }
        else if (to === this.currentUser) {
            chatMessage = {
                from,
                to: {
                    type: ChatRecipientType.Whisper,
                    name: to,
                },
                text,
                time,
            };
        }
        if (chatMessage) {
            this._onChatMessage.dispatch(this, chatMessage);
        }
    }

    private handleLoginQueueUpdate(reply: IrcRawReply): void {
        if (!reply.params) {
            throw new Error("Unexpected queue update reply " + reply.raw);
        }
        const [, position, avgWaitSeconds] = reply.params;
        this._onLoginQueueUpdate.dispatch(this, {
            position: Number(position.slice(1)),
            avgWaitSeconds: avgWaitSeconds ? Number(avgWaitSeconds) : 0,
        });
    }

    private handlePartyUpdate(message: string): void {
        const parts = message.split(" ");
        const rest = parts.slice(3).join(" ");
        const data = rest.startsWith(":") ? rest.slice(1) : rest;
        if (data) {
            this._onPartyUpdate.dispatch(this, data);
        }
    }

    private handleNamReply(reply: IrcRawReply): void {
        if (!reply.params) {
            throw new Error(`Missing NAMREPLY params: "${reply.raw}"`);
        }
        const channelName = IrcProtocol.unescapeChannelName(reply.params[2]);
        const users = this.parseNamReply(reply);
        const pending = this.pendingChannelUsers.get(channelName);
        if (pending) {
            pending.push(...users);
        }
        else {
            this.pendingChannelUsers.set(channelName, users);
        }
    }

    private handleEndOfNames(reply: IrcRawReply): void {
        if (!reply.params) {
            throw new Error(`Missing ENDOFNAMES params: "${reply.raw}"`);
        }
        const channelName = IrcProtocol.unescapeChannelName(reply.params[1]);
        const users = this.pendingChannelUsers.get(channelName) ?? [];
        users.sort((a, b) => Number(b.operator) - Number(a.operator));
        this.pendingChannelUsers.delete(channelName);
        this._onChannelUsers.dispatch(this, {
            channelName,
            users,
        });
    }

    private handleGameReport(reply: IrcRawReply): void {
        if (!reply.params) {
            throw new Error(`Missing GAME_REPORT params: "${reply.raw}"`);
        }
        if (reply.params.length < 2) {
            throw new Error("Insufficient number of params for GAME_REPORT: " + reply.params.length);
        }
        const report = WolGameReport.deserialize(reply.params[1].slice(1));
        this._onGameReport.dispatch(this, report);
    }

    private handleIrcError(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+) (\d+) ([^ ]+) (?:([^ ]*) )?:(.*)/i);
        if (!match) {
            return;
        }
        const [, from, codeString, target, , text] = match;
        if ([WolCode.ERR_NOSUCHNICK, WolCode.ERR_NOSUCHCHANNEL, WolCode.ERR_NOTONCHANNEL, WolCode.ERR_CHANOPRIVSNEEDED].includes(Number(codeString))) {
            let chatMessage: ChatMessage | undefined;
            if (target === this.currentUser) {
                chatMessage = {
                    from,
                    to: {
                        type: ChatRecipientType.Page,
                        name: target,
                    },
                    text,
                    time: new Date(),
                };
            }
            if (chatMessage) {
                this._onChatMessage.dispatch(this, chatMessage);
            }
        }
    }

    private handlePageOrNotice(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)(?:![^ ]+)? (?:PAGE|NOTICE) ([^ ]+) :(.*)/i);
        if (!match) {
            throw new Error(`Unexpected PAGE message format "${message}"`);
        }
        const [, from, target, text] = match;
        this._onChatMessage.dispatch(this, {
            from,
            to: {
                type: ChatRecipientType.Page,
                name: target,
            },
            text,
            time: new Date(),
        });
    }

    private handlePart(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)![^ ]+ PART ([^ ]+)/i);
        if (!match) {
            throw new Error(`Unexpected PART message format "${message}"`);
        }
        const [, userName, channelName] = match;
        const channel = IrcProtocol.unescapeChannelName(channelName);
        if (userName === this.currentUser) {
            if (channel === this.currentGameChannel) {
                this.currentGameChannel = undefined;
            }
            this.currentChannels.delete(channel);
            this.lastChannelOpts.delete(channel);
            this.pendingChannelUsers.delete(channel);
            this.logger.info(`Left channel "${channel}"`);
        }
        else if (channel === this.currentGameChannel) {
            this.logger.info(`Player "${userName}" left game "${channel}"`);
        }
        this._onLeaveChannel.dispatch(this, {
            type: "leave",
            user: {
                name: userName,
            },
            channel,
        });
    }

    private handleKick(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)![^ ]+ KICK ([^ ]+) ([A-Za-z0-9-_]+)/i);
        if (!match) {
            throw new Error(`Unexpected KICK message format "${message}"`);
        }
        const [, , channelName, userName] = match;
        const channel = IrcProtocol.unescapeChannelName(channelName);
        if (userName === this.currentUser) {
            if (channel === this.currentGameChannel) {
                this.currentGameChannel = undefined;
            }
            this.currentChannels.delete(channel);
            this.lastChannelOpts.delete(channel);
            this.pendingChannelUsers.delete(channel);
            this.logger.info(`Left channel "${channel}"`);
        }
        this._onLeaveChannel.dispatch(this, {
            type: "leave",
            user: {
                name: userName,
            },
            channel,
        });
    }

    private handleGameOpt(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)![^ ]+ GAMEOPT ([^ ]+) :(.*)/i);
        if (!match) {
            throw new Error(`Unexpected GAMEOPT message format"${message}"`);
        }
        const [, userName, , opt] = match;
        this._onGameOpt.dispatch(this, {
            user: userName,
            opt,
        });
    }

    private handleMode(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+)![^ ]+ MODE ([^ ]+) \+l (\d+)/i);
        if (match) {
            this._onGameMode.dispatch(this, Number(match[3]));
        }
        else {
            this.logger.warn("Got unknown MODE line: " + message);
        }
    }

    static CHAN_OP_PREFIX = "@";
}
