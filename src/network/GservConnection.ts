import { EventDispatcher } from "@/util/event";
import { DataStream } from "@/data/DataStream";
import { IrcConnection, type ConnectOptions } from "@/network/IrcConnection";
import * as GservCode from "@/network/gservCodes";
import { GservError } from "@/network/GservError";
import { API_VERSION, RECIPIENT_ALL, RECIPIENT_TEAM, GSERV_LOGIN_TIMEOUT_SECONDS, DEFAULT_GAME_COUNTDOWN_MILLIS } from "@/network/gservConfig";
import { ChatRecipientType, ChatMessage } from "@/network/chat/ChatMessage";
import type { Logger } from "@/network/Logger";

const gservErrorCodeMap: Map<number, GservError.Code> = new Map([
    [GservCode.RPL_BAD_LOGIN, GservError.Code.BadLogin],
    [GservCode.RPL_TOO_MANY_LOGIN_ATTEMPTS, GservError.Code.TooManyLoginAttempts],
    [GservCode.RPL_ALREADY_LOGGED_IN, GservError.Code.AlreadyLoggedIn],
    [GservCode.RPL_SERVICE_UNAVAILABLE, GservError.Code.ServiceUnavailable],
    [GservCode.RPL_INSTANCE_NONEXISTENT, GservError.Code.InstanceNonExistent],
    [GservCode.RPL_INSTANCE_NOT_ALLOWED, GservError.Code.InstanceNotAllowed],
    [GservCode.RPL_INSTANCE_ALREADY_STARTED, GservError.Code.InstanceAlreadyStarted],
    [GservCode.RPL_INSTANCE_VERS_MISMATCH, GservError.Code.InstanceVersMismatch],
]);

export type VoteChoice = "kick" | "wait";

/** A kick/wait vote has opened on a player who dropped mid-game. */
export interface VoteSessionInfo {
    /** The departed player being voted on. */
    targetNick: string;
    extensionsMax: number;
    extensionSeconds: number;
}

/** Live tally of an open kick/wait vote, rebroadcast on every cast vote. */
export interface VoteTally {
    targetNick: string;
    kickVotes: number;
    waitVotes: number;
    /** Remaining "wait" extensions; at zero, wait votes stop vetoing a kick. */
    extensionsRemaining: number;
    /** How many players may vote, and how many kick votes carry the motion. */
    eligibleCount: number;
    majorityThreshold: number;
    /** Who has voted so far, and for what. */
    votesByNick: Map<string, VoteChoice>;
}

export class GservConnection {
    private currentUser?: string;
    private serverName?: string;
    private _onLoadInfo = new EventDispatcher<GservConnection, string>();
    private _onGameStart = new EventDispatcher<GservConnection, undefined>();
    private _onGameActions = new EventDispatcher<GservConnection, Uint8Array>();
    private _onGameDesync = new EventDispatcher<GservConnection>();
    private _onRateChange = new EventDispatcher<GservConnection, { rate: number; turnNo: number }>();
    private _onChatMessage = new EventDispatcher<GservConnection, ChatMessage>();
    private _onTaunt = new EventDispatcher<GservConnection, { from: string; tauntNo: number }>();
    private _onPlayerDisconnect = new EventDispatcher<GservConnection, string>();
    private _onPlayerReconnecting = new EventDispatcher<GservConnection, string>();
    private _onPlayerReconnected = new EventDispatcher<GservConnection, string>();
    private _onPlayerGaveUp = new EventDispatcher<GservConnection, string>();
    private _onPauseCountdown = new EventDispatcher<GservConnection, number>();
    private _onPaused = new EventDispatcher<GservConnection>();
    private _onResumeCountdown = new EventDispatcher<GservConnection, number>();
    private _onResumed = new EventDispatcher<GservConnection>();
    private _onVoteSessionOpened = new EventDispatcher<GservConnection, VoteSessionInfo>();
    private _onVoteUpdate = new EventDispatcher<GservConnection, VoteTally>();
    private _onVoteSessionClosed = new EventDispatcher<GservConnection, string>();
    private _onResyncLogComplete = new EventDispatcher<GservConnection>();
    private _onPrivMsgNotAllowed = new EventDispatcher<GservConnection>();
    private resyncTurnCount?: number;
    private resyncFrames = new Map<number, Uint8Array>();
    private lastNetRate?: { rate: number; turnNo: number };
    get onError() {
        return this.con.onError;
    }
    get onClose() {
        return this.con.onClose;
    }
    get onLoadInfo() {
        return this._onLoadInfo.asEvent();
    }
    get onGameStart() {
        return this._onGameStart.asEvent();
    }
    get onGameActions() {
        return this._onGameActions.asEvent();
    }
    get onGameDesync() {
        return this._onGameDesync.asEvent();
    }
    get onRateChange() {
        return this._onRateChange.asEvent();
    }
    get onChatMessage() {
        return this._onChatMessage.asEvent();
    }
    get onTaunt() {
        return this._onTaunt.asEvent();
    }
    get onPlayerDisconnect() {
        return this._onPlayerDisconnect.asEvent();
    }
    get onPlayerReconnecting() {
        return this._onPlayerReconnecting.asEvent();
    }
    get onPlayerReconnected() {
        return this._onPlayerReconnected.asEvent();
    }
    get onPlayerGaveUp() {
        return this._onPlayerGaveUp.asEvent();
    }
    get onPauseCountdown() {
        return this._onPauseCountdown.asEvent();
    }
    get onPaused() {
        return this._onPaused.asEvent();
    }
    get onResumeCountdown() {
        return this._onResumeCountdown.asEvent();
    }
    get onResumed() {
        return this._onResumed.asEvent();
    }
    get onPrivMsgNotAllowed() {
        return this._onPrivMsgNotAllowed.asEvent();
    }
    get onVoteSessionOpened() {
        return this._onVoteSessionOpened.asEvent();
    }
    get onVoteUpdate() {
        return this._onVoteUpdate.asEvent();
    }
    get onVoteSessionClosed() {
        return this._onVoteSessionClosed.asEvent();
    }

    static factory(logger: Logger): GservConnection {
        return new this(new IrcConnection({
            mode: "text",
            binaryRplPrefix: GservCode.RPL_BIN_PREFIX,
            binaryReqPrefix: GservCode.REQ_BIN_PREFIX,
            logFilter: (message) => message
                .replace(/^(ticket) [^ \r\n]+/i, "$1 <redacted>")
                .replace(/^((:.+!.+@.+)?privmsg ([^ ]+ )+):(.+)\r?\n?$/i, "$1:<redacted>"),
        }, logger));
    }

    constructor(private con: IrcConnection) {
        this.handleMessage = (message: string | Uint8Array) => {
            if (typeof message === "string") {
                const parts = message.split(" ");
                if (parts[0]?.toLowerCase() === "ping") {
                    if (this.isOpen()) {
                        this.con.sendMessage("pong" + (parts[1] ? " " + parts[1] : ""));
                    }
                }
                else if (parts[1]?.toLowerCase() === "privmsg") {
                    this.handlePrivMsg(message);
                }
                else if (parts[1] === "" + GservCode.RPL_LOAD_INFO) {
                    this.handleLoadInfo(parts[3]);
                }
                else if (parts[1] === "" + GservCode.RPL_GAME_START) {
                    this.handleGameStart();
                }
                else if (parts[1] === "" + GservCode.RPL_GAME_DESYNC) {
                    this._onGameDesync.dispatch(this);
                }
                else if (parts[1] === "" + GservCode.RPL_NET_RATE) {
                    const [rate, turnNo] = parts[3].slice(1).split(",");
                    this.lastNetRate = {
                        rate: Number(rate),
                        turnNo: Number(turnNo),
                    };
                    this._onRateChange.dispatch(this, {
                        rate: Number(rate),
                        turnNo: Number(turnNo),
                    });
                }
                else if (parts[1] === "" + GservCode.RPL_TAUNT) {
                    // RPL_TAUNT is a server-authored numeric reply
                    // (":<serverName> <code> <nick> :<tauntNo>"), not a
                    // PRIVMSG — the taunting player's nick is the parameter
                    // at parts[2], same as every other RPL_* code here.
                    // parts[0] is the *server's* name prefix, not theirs.
                    this._onTaunt.dispatch(this, {
                        from: parts[2],
                        tauntNo: Number(parts[3].replace(/^:/, "")),
                    });
                }
                else if (parts[1] === "" + GservCode.RPL_PLAYER_DISCONNECT) {
                    this._onPlayerDisconnect.dispatch(this, parts[3].replace(/^:/, ""));
                }
                else if (parts[1] === "" + GservCode.RPL_PLAYER_RECONNECTING) {
                    this._onPlayerReconnecting.dispatch(this, parts[3].replace(/^:/, ""));
                }
                else if (parts[1] === "" + GservCode.RPL_PLAYER_RECONNECTED) {
                    this._onPlayerReconnected.dispatch(this, parts[3].replace(/^:/, ""));
                }
                else if (parts[1] === "" + GservCode.RPL_PLAYER_GAVE_UP) {
                    this._onPlayerGaveUp.dispatch(this, parts[3].replace(/^:/, ""));
                }
                else if (parts[1] === "" + GservCode.RPL_GAME_PAUSE_COUNTDOWN) {
                    this._onPauseCountdown.dispatch(this, this.parseCountdownMillis(parts[3]));
                }
                else if (parts[1] === "" + GservCode.RPL_GAME_PAUSED) {
                    this._onPaused.dispatch(this);
                }
                else if (parts[1] === "" + GservCode.RPL_GAME_RESUME_COUNTDOWN) {
                    this._onResumeCountdown.dispatch(this, this.parseCountdownMillis(parts[3]));
                }
                else if (parts[1] === "" + GservCode.RPL_GAME_RESUMED) {
                    this._onResumed.dispatch(this);
                }
                else if (parts[1] === "" + GservCode.RPL_VOTE_SESSION_OPENED) {
                    const fields = (parts[3] ?? "").replace(/^:/, "").split(",");
                    this._onVoteSessionOpened.dispatch(this, {
                        targetNick: fields[0] ?? "",
                        extensionsMax: Number(fields[1] ?? 0),
                        extensionSeconds: Number(fields[2] ?? 0),
                    });
                }
                else if (parts[1] === "" + GservCode.RPL_VOTE_UPDATE) {
                    const tally = this.parseVoteUpdate(parts[3]);
                    if (tally) {
                        this._onVoteUpdate.dispatch(this, tally);
                    }
                }
                else if (parts[1] === "" + GservCode.RPL_VOTE_SESSION_CLOSED) {
                    this._onVoteSessionClosed.dispatch(this, parts[3].replace(/^:/, ""));
                }
                else if (parts[1] === "" + GservCode.RPL_RESYNC) {
                    this.resyncTurnCount = Number(parts[3]?.replace(/^:/, "") ?? -1);
                    this.resyncFrames.clear();
                }
                else if (parts[1] === "" + GservCode.RPL_PRIVMSG_NOT_ALLOWED) {
                    this._onPrivMsgNotAllowed.dispatch(this);
                }
            }
            else if (message[0] === GservCode.RPL_BIN_GAME_ACTIONS) {
                this.handlePlayerActions(message.subarray(1));
            }
            else if (message[0] === GservCode.RPL_BIN_RESYNC) {
                this.handleResyncActions(message.subarray(1));
            }
        };
        this.con = con;
    }

    private handleMessage: (message: string | Uint8Array) => void;

    getCurrentUser(): string | undefined {
        return this.currentUser;
    }

    getServerName(): string | undefined {
        return this.serverName;
    }

    async connect(url: string, options?: ConnectOptions): Promise<void> {
        this.con.onMessage.subscribe(this.handleMessage);
        await this.con.connect(url, options);
    }

    close(): void {
        this.con.onMessage.unsubscribe(this.handleMessage);
        this.con.close();
        this.currentUser = undefined;
    }

    isOpen(): boolean {
        return this.con.isOpen();
    }

    async cvers(version: string): Promise<void> {
        const replies = await this.con.sendCommand(`cvers ${version} ` + API_VERSION, {
            replyCodes: [GservCode.RPL_CVERS_OK, GservCode.RPL_CVERS_OUTDATED],
        });
        if (replies[0].code === GservCode.RPL_CVERS_OUTDATED) {
            const reason = replies[0].params ? replies[0].params.splice(1).join(" ").replace(/^:/, "") : "unknown";
            throw new GservError("Cvers error: " + reason, GservError.Code.OutdatedClient);
        }
    }

    async login(ticket: string, username: string): Promise<void> {
        const replies = await this.con.sendCommand("ticket " + ticket, {
            replyCodes: [
                GservCode.RPL_LOGGED_IN,
                GservCode.RPL_BAD_LOGIN,
                GservCode.RPL_TOO_MANY_LOGIN_ATTEMPTS,
                GservCode.RPL_ALREADY_LOGGED_IN,
                GservCode.RPL_SERVICE_UNAVAILABLE,
            ],
            timeout: GSERV_LOGIN_TIMEOUT_SECONDS,
        });
        if (replies[0].code !== GservCode.RPL_LOGGED_IN) {
            const code = gservErrorCodeMap.get(replies[0].code) ?? GservError.Code.Unknown;
            const reason = replies[0].params ? replies[0].params.splice(1).join(" ").replace(/^:/, "") : "unknown";
            throw new GservError("Login error: " + reason, code);
        }
        this.currentUser = username;
        this.serverName = replies[0].raw.match(/^:([^\s]+)/)?.[1] || "";
    }

    async joinGame(gameId: string, version: string, modHash: string): Promise<void> {
        // Drop any resync log left over from a previous game instance on this
        // connection. Without this, starting a fresh game right after
        // rejoining an earlier one would see the stale log via
        // getResyncLog() and incorrectly replay the old match's turns.
        this.resyncTurnCount = undefined;
        this.resyncFrames = new Map();
        const replies = await this.con.sendCommand(`join ${gameId} ${version} ${modHash}`, {
            replyCodes: [
                GservCode.RPL_INSTANCE_CONNECTED,
                GservCode.RPL_INSTANCE_NONEXISTENT,
                GservCode.RPL_INSTANCE_NOT_ALLOWED,
                GservCode.RPL_INSTANCE_ALREADY_STARTED,
                GservCode.RPL_INSTANCE_VERS_MISMATCH,
            ],
        });
        if (replies[0].code !== GservCode.RPL_INSTANCE_CONNECTED) {
            const code = gservErrorCodeMap.get(replies[0].code) ?? GservError.Code.Unknown;
            const reason = replies[0].params ? replies[0].params.splice(1).join(" ").replace(/^:/, "") : "unknown";
            throw new GservError("Join error: " + reason, code);
        }
    }

    async gameOpts(): Promise<string> {
        const replies = await this.con.sendCommand("gameopts", {
            replyCodes: [GservCode.RPL_GAME_OPTS],
        });
        if (!replies[0].params) {
            throw new Error("Unexpected server reply for getopts command. Missing params.");
        }
        return replies[0].params.splice(1).join(" ").replace(/^:/, "");
    }

    sendLoadedPercent(percent: number): void {
        this.con.sendMessage("loaded " + percent);
    }

    requestLoadInfo(): void {
        this.con.sendMessage("loadinfo");
    }

    sendGameStateHash(turnNo: number, hash: number): void {
        const stream = new DataStream(10);
        stream.dynamicSize = false;
        stream.writeUint8(GservCode.REQ_BIN_PREFIX);
        stream.writeUint8(GservCode.REQ_BIN_GAME_STATE_HASH);
        stream.writeUint32(turnNo);
        stream.writeUint32(hash);
        this.con.sendMessage(stream.toUint8Array());
    }

    sendPlayerActive(active: boolean): void {
        this.con.sendMessage("active " + (active ? 1 : 0));
    }

    sendTaunt(tauntNo: number): void {
        this.con.sendMessage("taunt " + tauntNo);
    }

    ping(timeoutSeconds: number): Promise<number> {
        return this.con.ping(timeoutSeconds);
    }

    sendPlayerActions(turnNo: number, actions: Uint8Array): void {
        const stream = new DataStream(6);
        stream.writeUint8(GservCode.REQ_BIN_PREFIX);
        stream.writeUint8(GservCode.REQ_BIN_GAME_ACTIONS);
        stream.writeUint32(turnNo);
        stream.writeUint8Array(actions);
        this.con.sendMessage(stream.toUint8Array());
    }

    private handleLoadInfo(loadInfo: string): void {
        this._onLoadInfo.dispatch(this, loadInfo.replace(/^:/, ""));
    }

    // RPL_VOTE_UPDATE's trailing param is
    // ":<target>,<kick>,<wait>,<extLeft>,<eligible>,<threshold>,<nick>=<choice>;..."
    // The ballot tail is empty until someone actually votes, which is the
    // normal state for the opening broadcast.
    private parseVoteUpdate(param: string | undefined): VoteTally | undefined {
        const fields = (param ?? "").replace(/^:/, "").split(",");
        if (fields.length < 6 || !fields[0]) {
            return undefined;
        }
        const votesByNick = new Map<string, VoteChoice>();
        for (const entry of (fields[6] ?? "").split(";")) {
            if (!entry) {
                continue;
            }
            const [nick, choice] = entry.split("=");
            if (nick && (choice === "kick" || choice === "wait")) {
                votesByNick.set(nick, choice);
            }
        }
        return {
            targetNick: fields[0],
            kickVotes: Number(fields[1]),
            waitVotes: Number(fields[2]),
            extensionsRemaining: Number(fields[3]),
            eligibleCount: Number(fields[4]),
            majorityThreshold: Number(fields[5]),
            votesByNick,
        };
    }

    // Cast (or change) this player's vote on a departed player: "kick" ends
    // their rejoin window now, "wait" buys them another extension. Fire and
    // forget like pause/resume -- the resulting tally arrives asynchronously
    // as RPL_VOTE_UPDATE.
    sendVote(targetNick: string, choice: VoteChoice): void {
        this.con.sendMessage(`vote ${targetNick} ${choice}`);
    }

    // RPL_GAME_PAUSE_COUNTDOWN/RPL_GAME_RESUME_COUNTDOWN's trailing param is
    // ":<nick>,<countdownMillis>" — the server's actual configured countdown
    // length, so the client renders a countdown that matches the real
    // server-side timer instead of a hardcoded guess.
    private parseCountdownMillis(param: string | undefined): number {
        const millis = Number(param?.replace(/^:/, "").split(",")[1]);
        return Number.isFinite(millis) && millis > 0 ? millis : DEFAULT_GAME_COUNTDOWN_MILLIS;
    }

    private handleGameStart(): void {
        this._onGameStart.dispatch(this, undefined);
    }

    private handlePlayerActions(actions: Uint8Array): void {
        this._onGameActions.dispatch(this, actions);
    }

    private handleResyncActions(payload: Uint8Array): void {
        const turnNo = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
        // Keep the [u32 turnNo][all-player blobs] payload intact so the resync
        // catch-up can feed it through the same parser as a live relay frame.
        this.resyncFrames.set(turnNo, payload);
        if (this.resyncTurnCount !== undefined && this.resyncFrames.size >= this.resyncTurnCount + 1) {
            this._onResyncLogComplete.dispatch(this);
        }
    }

    get onResyncLogComplete() {
        return this._onResyncLogComplete.asEvent();
    }

    getResyncLog(): { turnCount: number; frames: Map<number, Uint8Array> } | undefined {
        if (this.resyncTurnCount === undefined) {
            return undefined;
        }
        return {
            turnCount: this.resyncTurnCount,
            frames: this.resyncFrames,
        };
    }

    // The most recent net-rate the server announced. The rejoin path needs it
    // because the server sends RPL_NET_RATE immediately after a re-join, before
    // the game screen subscribes to onRateChange.
    getLastNetRate(): { rate: number; turnNo: number } | undefined {
        return this.lastNetRate;
    }

    sendReady(turnNo: number): void {
        this.con.sendMessage("ready " + turnNo);
    }

    sendPause(): void {
        this.con.sendMessage("pause");
    }

    sendResume(): void {
        this.con.sendMessage("resume");
    }

    // Voluntary quit ("Abort Mission"): tells the server this nick is gone for
    // good, distinct from an accidental disconnect, so it skips the rejoin
    // grace window entirely instead of holding a slot for a reconnect that
    // will never come.
    sendLeave(): void {
        this.con.sendMessage("leave");
    }

    sayChannel(message: string): void {
        this.privmsg([RECIPIENT_ALL], message);
    }

    privmsg(recipients: string[], text: string): void {
        if (!this.currentUser) {
            throw new Error("Must login before sending messages");
        }
        if (text.length) {
            const recipientList = recipients.join(",");
            this.con.sendMessage(`privmsg ${recipientList} :` + text);
        }
        const channels = recipients.filter((recipient) => recipient === RECIPIENT_ALL || recipient === RECIPIENT_TEAM);
        if (channels.length) {
            channels.forEach((recipient) => {
                this._onChatMessage.dispatch(this, {
                    from: this.currentUser,
                    to: {
                        type: ChatRecipientType.Channel,
                        name: recipient,
                    },
                    text,
                    time: new Date(),
                });
            });
        }
        else {
            this._onChatMessage.dispatch(this, {
                from: this.currentUser,
                to: {
                    type: ChatRecipientType.Channel,
                    name: RECIPIENT_TEAM,
                },
                text,
                time: new Date(),
            });
        }
    }

    private handlePrivMsg(message: string): void {
        const match = message.match(/^:([A-Za-z0-9-_]+) PRIVMSG ([A-Za-z0-9-_#']+) :(.*)/i);
        if (!match) {
            throw new Error(`Unexpected PRIVMSG message format "${message}"`);
        }
        const [, from, recipient, text] = match;
        let chatMessage: ChatMessage | undefined;
        const time = new Date();
        if (recipient === RECIPIENT_ALL) {
            chatMessage = {
                from,
                to: {
                    type: ChatRecipientType.Channel,
                    name: recipient,
                },
                text,
                time,
            };
        }
        else if (recipient === this.currentUser) {
            chatMessage = {
                from,
                to: from === this.getServerName() ? {
                    type: ChatRecipientType.Page,
                    name: recipient,
                } : {
                    type: ChatRecipientType.Channel,
                    name: RECIPIENT_TEAM,
                },
                text,
                time,
            };
        }
        if (chatMessage) {
            this._onChatMessage.dispatch(this, chatMessage);
        }
    }
}
