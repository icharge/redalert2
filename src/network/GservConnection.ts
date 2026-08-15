import { EventDispatcher } from "@/util/event";
import { DataStream } from "@/data/DataStream";
import { IrcConnection } from "@/network/IrcConnection";
import * as GservCode from "@/network/gservCodes";
import { GservError } from "@/network/GservError";
import { API_VERSION, RECIPIENT_ALL, RECIPIENT_TEAM, GSERV_LOGIN_TIMEOUT_SECONDS } from "@/network/gservConfig";
import { ChatRecipientType, ChatMessage } from "@/network/chat/ChatMessage";

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
    private _onPrivMsgNotAllowed = new EventDispatcher<GservConnection>();

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
    get onPrivMsgNotAllowed() {
        return this._onPrivMsgNotAllowed.asEvent();
    }

    static factory(logger: any): GservConnection {
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
        this.handleMessage = (message: any) => {
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
                    this._onRateChange.dispatch(this, {
                        rate: Number(rate),
                        turnNo: Number(turnNo),
                    });
                }
                else if (parts[1] === "" + GservCode.RPL_TAUNT) {
                    this._onTaunt.dispatch(this, {
                        from: parts[0].replace(/^:/, ""),
                        tauntNo: Number(parts[3].replace(/^:/, "")),
                    });
                }
                else if (parts[1] === "" + GservCode.RPL_PLAYER_DISCONNECT) {
                    this._onPlayerDisconnect.dispatch(this, parts[3].replace(/^:/, ""));
                }
                else if (parts[1] === "" + GservCode.RPL_PRIVMSG_NOT_ALLOWED) {
                    this._onPrivMsgNotAllowed.dispatch(this);
                }
            }
            else if (message[0] === GservCode.RPL_BIN_GAME_ACTIONS) {
                this.handlePlayerActions(message.subarray(1));
            }
        };
        this.con = con;
    }

    private handleMessage: (message: any) => void;

    getCurrentUser(): string | undefined {
        return this.currentUser;
    }

    getServerName(): string | undefined {
        return this.serverName;
    }

    async connect(url: string, options?: any): Promise<void> {
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

    private handleGameStart(): void {
        this._onGameStart.dispatch(this, undefined);
    }

    private handlePlayerActions(actions: Uint8Array): void {
        this._onGameActions.dispatch(this, actions);
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
