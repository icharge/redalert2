import { ServerConfig } from "../config";
import { Logger, makeLogger } from "../logger";
import { GservInstance, GservManager } from "./GservManager";
import { SocketLike } from "../server/SocketLike";
import * as Code from "../protocol/gservCodes";
import { GSERV_SERVER_NAME } from "../protocol/replies";
import { GservReplayRecorder } from "./replay/GservReplayRecorder";
import {
    ActionData,
    NO_ACTION_ID,
    parsePlayerActions,
    serializeAllPlayerActions,
} from "./replay/gameoptCodec";

export interface GservClient {
    socket: SocketLike;
    nick: string;
    authenticated: boolean;
    instance?: GservInstance;
    loaded: number;
    active: boolean;
}

interface PendingSubmission {
    playerId: number;
    actions: ActionData[];
}

interface InstanceState {
    recorder: GservReplayRecorder;
    members: Map<string, GservClient>;
    requiredNicks: Set<string>;
    pending: Map<number, Map<string, PendingSubmission>>;
    lastTurnNo: number;
}

export class GservServer {
    readonly serverName = GSERV_SERVER_NAME;
    readonly log: Logger;
    private clients = new Map<SocketLike, GservClient>();
    private instanceMembers = new Map<string, Map<string, GservClient>>();
    private instanceStates = new Map<string, InstanceState>();

    constructor(
        private config: ServerConfig,
        private manager: GservManager,
    ) {
        this.log = makeLogger(config.logLevel, "gserv");
    }

    handleOpen(socket: SocketLike): GservClient {
        const client: GservClient = {
            socket,
            nick: "*",
            authenticated: false,
            loaded: 0,
            active: true,
        };
        this.clients.set(socket, client);
        this.log.debug("gserv connection open");
        return client;
    }

    handleClose(client: GservClient): void {
        if (client.instance) {
            const gameId = client.instance.gameId;
            this.log.info(`disconnect ${client.nick} from instance ${gameId}`);
            this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_DISCONNECT} ${client.nick} :${client.nick}`);
            const members = this.instanceMembers.get(gameId);
            members?.delete(client.nick);
            const state = this.instanceStates.get(gameId);
            if (state) {
                state.requiredNicks.delete(client.nick);
                // If a member dropped without submitting a pending turn, treat their
                // missing submissions as NoAction so the game can keep advancing.
                const playerId = state.recorder.playerIdFor(client.nick);
                if (playerId !== undefined) {
                    for (const submissions of state.pending.values()) {
                        if (!submissions.has(client.nick)) {
                            submissions.set(client.nick, {
                                playerId,
                                actions: [{ id: NO_ACTION_ID, params: new Uint8Array() }],
                            });
                        }
                    }
                }
                this.flushPendingTurns(state);
                if (!members || members.size === 0) {
                    this.finalizeInstance(gameId, state);
                }
            }
        }
        else {
            this.log.debug("gserv connection closed (not authenticated)");
        }
        this.clients.delete(client.socket);
    }

    handleMessage(client: GservClient, message: string | Uint8Array): void {
        if (typeof message !== "string") {
            this.handleBinary(client, new Uint8Array(message));
            return;
        }
        for (const line of message.split(/\r?\n/)) {
            if (line.length) {
                this.handleLine(client, line);
            }
        }
    }

    private handleLine(client: GservClient, line: string): void {
        const parts = line.split(" ");
        const cmd = parts[0].toLowerCase();
        switch (cmd) {
            case "ping": {
                const token = (parts[1] ?? "").replace(/^:/, "");
                client.socket.send(`:${this.serverName} PONG ${client.nick} :${token}\r\n`);
                break;
            }
            case "pong":
                break;
            case "cvers":
                this.handleCvers(client, parts);
                break;
            case "ticket":
                this.handleTicket(client, parts);
                break;
            case "join":
                this.handleJoin(client, parts);
                break;
            case "gameopts":
                this.handleGameOpts(client);
                break;
            case "loaded":
                this.handleLoaded(client, parts);
                break;
            case "loadinfo":
                this.handleLoadInfo(client);
                break;
            case "active":
                client.active = parts[1] === "1";
                break;
            case "taunt":
                this.handleTaunt(client, parts);
                break;
            case "privmsg":
                this.handlePrivmsg(client, line);
                break;
            default:
                break;
        }
    }

    private handleCvers(client: GservClient, parts: string[]): void {
        const version = parts[1] ?? "";
        client.socket.send(`:${this.serverName} ${Code.RPL_CVERS_OK} ${client.nick} :ok\r\n`);
    }

    private handleTicket(client: GservClient, parts: string[]): void {
        const ticket = parts[1];
        if (!ticket) {
            client.socket.send(`:${this.serverName} ${Code.RPL_BAD_LOGIN} ${client.nick} :missing ticket\r\n`);
            return;
        }
        const info = this.manager.validateTicket(ticket);
        if (!info) {
            this.log.warn("login rejected: invalid ticket");
            client.socket.send(`:${this.serverName} ${Code.RPL_BAD_LOGIN} ${client.nick} :invalid ticket\r\n`);
            return;
        }
        client.nick = info.nick;
        client.authenticated = true;
        this.log.info(`login ${client.nick}`);
        client.socket.send(`:${this.serverName} ${Code.RPL_LOGGED_IN} ${client.nick} :logged in\r\n`);
    }

    private handleJoin(client: GservClient, parts: string[]): void {
        if (!client.authenticated) {
            client.socket.send(`:${this.serverName} ${Code.RPL_NOT_LOGGED_IN} ${client.nick} :not logged in\r\n`);
            return;
        }
        const gameId = parts[1];
        const version = parts[2];
        const modHash = parts[3];
        const instance = gameId ? this.manager.get(gameId) : undefined;
        if (!instance) {
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_NONEXISTENT} ${client.nick} :no such instance\r\n`);
            return;
        }
        if (instance.started) {
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_ALREADY_STARTED} ${client.nick} :instance already started\r\n`);
            return;
        }
        if (version && version.split(".").slice(0, 2).join(".") !== this.config.gameVersion.split(".").slice(0, 2).join(".")) {
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_VERS_MISMATCH} ${client.nick} :version mismatch\r\n`);
            return;
        }
        if (this.config.expectedModHash !== undefined && modHash !== this.config.expectedModHash) {
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_VERS_MISMATCH} ${client.nick} :mod hash mismatch\r\n`);
            return;
        }
        if (!instance.tickets.has(client.nick)) {
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_NOT_ALLOWED} ${client.nick} :not allowed\r\n`);
            return;
        }
        client.instance = instance;
        let members = this.instanceMembers.get(gameId);
        if (!members) {
            members = new Map();
            this.instanceMembers.set(gameId, members);
        }
        members.set(client.nick, client);
        this.log.info(`join instance ${gameId} as ${client.nick}`);
        client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_CONNECTED} ${client.nick} :connected\r\n`);
    }

    private handleGameOpts(client: GservClient): void {
        const opts = client.instance?.gameopts ?? "";
        client.socket.send(`:${this.serverName} ${Code.RPL_GAME_OPTS} ${client.nick} :${opts}\r\n`);
    }

    private handleLoaded(client: GservClient, parts: string[]): void {
        if (!client.instance) {
            return;
        }
        client.loaded = Number(parts[1] ?? 0);
        this.checkAllLoaded(client.instance);
    }

    private checkAllLoaded(instance: GservInstance): void {
        if (instance.started) {
            return;
        }
        const members = this.instanceMembers.get(instance.gameId);
        if (!members || members.size === 0) {
            return;
        }
        if (![...members.values()].every(member => member.loaded >= 100)) {
            return;
        }
        instance.started = true;
        this.log.info(`instance ${instance.gameId} started`);
        const recorder = new GservReplayRecorder(instance, {
            gameVersion: this.config.gameVersion,
            modHash: this.config.expectedModHash,
            netRateMs: this.config.netRateMs,
            replaysDir: this.config.replaysDir,
            log: this.log,
        });
        const requiredNicks = new Set<string>();
        for (const member of members.values()) {
            if (recorder.playerIdFor(member.nick) !== undefined && !recorder.isObserver(member.nick)) {
                requiredNicks.add(member.nick);
            }
        }
        this.instanceStates.set(instance.gameId, {
            recorder,
            members,
            requiredNicks,
            pending: new Map(),
            lastTurnNo: -1,
        });
        for (const member of members.values()) {
            member.socket.send(`:${this.serverName} ${Code.RPL_NET_RATE} ${member.nick} :${this.config.netRateMs},0\r\n`);
            member.socket.send(`:${this.serverName} ${Code.RPL_GAME_START} ${member.nick} :start\r\n`);
        }
    }

    private handleLoadInfo(client: GservClient): void {
        if (!client.instance) {
            return;
        }
        const members = this.instanceMembers.get(client.instance.gameId);
        const lines: string[] = [];
        if (members) {
            for (const member of members.values()) {
                lines.push(`${member.nick},0,${member.loaded},0,0,0`);
            }
        }
        client.socket.send(`:${this.serverName} ${Code.RPL_LOAD_INFO} ${client.nick} :${lines.join(",")}\r\n`);
    }

    private handleTaunt(client: GservClient, parts: string[]): void {
        this.broadcastLine(client, `:${this.serverName} ${Code.RPL_TAUNT} ${client.nick} :${parts[1] ?? "0"}`);
        const state = client.instance ? this.instanceStates.get(client.instance.gameId) : undefined;
        state?.recorder.recordTaunt(client.nick, Number(parts[1] ?? 0));
    }

    private handlePrivmsg(client: GservClient, line: string): void {
        const sep = line.indexOf(" :");
        if (sep === -1) {
            return;
        }
        const target = line.slice(8, sep).trim();
        const text = line.slice(sep + 2);
        if (target === "#all" || target === "#team") {
            this.broadcastLine(client, `:${client.nick} PRIVMSG ${target} :${text}`);
            const state = client.instance ? this.instanceStates.get(client.instance.gameId) : undefined;
            state?.recorder.recordChat(client.nick, text);
        }
        else if (target !== client.nick) {
            const member = this.findMember(client, target);
            if (member) {
                member.socket.send(`:${client.nick} PRIVMSG ${target} :${text}\r\n`);
            }
            else {
                client.socket.send(`:${this.serverName} ${Code.RPL_PRIVMSG_NOT_ALLOWED} ${client.nick} :not allowed\r\n`);
            }
        }
    }

    private handleBinary(client: GservClient, data: Uint8Array): void {
        if (data.length < 6 || data[0] !== Code.REQ_BIN_PREFIX) {
            return;
        }
        if (data[1] !== Code.REQ_BIN_GAME_ACTIONS || !client.instance) {
            return;
        }
        const state = this.instanceStates.get(client.instance.gameId);
        if (!state) {
            return;
        }
        const playerId = state.recorder.playerIdFor(client.nick);
        if (playerId === undefined) {
            this.log.warn(`ignoring actions from ${client.nick}: no player slot in gameopts`);
            return;
        }
        const turnNo = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2, true);
        let submissions = state.pending.get(turnNo);
        if (!submissions) {
            submissions = new Map();
            state.pending.set(turnNo, submissions);
        }
        submissions.set(client.nick, { playerId, actions: parsePlayerActions(data.subarray(6)) });
        this.flushPendingTurns(state);
    }

    private flushPendingTurns(state: InstanceState): void {
        for (const turnNo of [...state.pending.keys()].sort((a, b) => a - b)) {
            const submissions = state.pending.get(turnNo);
            if (submissions && [...state.requiredNicks].every(nick => submissions.has(nick))) {
                this.broadcastTurn(state, turnNo);
            }
        }
    }

    private broadcastTurn(state: InstanceState, turnNo: number): void {
        const submissions = state.pending.get(turnNo);
        if (!submissions) {
            return;
        }
        const allActions = new Map<number, ActionData[]>();
        for (const submission of submissions.values()) {
            allActions.set(submission.playerId, submission.actions);
        }
        state.recorder.recordTurn(turnNo, allActions);
        const payload = serializeAllPlayerActions(allActions);
        const frame = new Uint8Array(6 + payload.length);
        frame[0] = Code.RPL_BIN_PREFIX;
        frame[1] = Code.RPL_BIN_GAME_ACTIONS;
        new DataView(frame.buffer).setUint32(2, turnNo, true);
        frame.set(payload, 6);
        for (const member of state.members.values()) {
            member.socket.send(frame);
        }
        state.pending.delete(turnNo);
        state.lastTurnNo = Math.max(state.lastTurnNo, turnNo);
        this.log.debug(`relayed turn ${turnNo} (${allActions.size} player(s))`);
    }

    private finalizeInstance(gameId: string, state: InstanceState): void {
        this.instanceStates.delete(gameId);
        if (!state.recorder.hasEvents) {
            this.log.debug(`instance ${gameId} ended with no events; skipping replay`);
            return;
        }
        try {
            const filePath = state.recorder.finalize();
            this.log.info(`saved replay for instance ${gameId}: ${filePath}`);
        }
        catch (error) {
            this.log.error(`failed to save replay for instance ${gameId}: ${(error as Error).message}`);
        }
    }

    private findMember(client: GservClient, nick: string): GservClient | undefined {
        if (!client.instance) {
            return undefined;
        }
        return this.instanceMembers.get(client.instance.gameId)?.get(nick);
    }

    private broadcastLine(sender: GservClient, line: string): void {
        this.forEachOtherMember(sender, other => other.socket.send(line));
    }

    private forEachOtherMember(sender: GservClient, fn: (member: GservClient) => void): void {
        if (!sender.instance) {
            return;
        }
        const members = this.instanceMembers.get(sender.instance.gameId);
        if (!members) {
            return;
        }
        for (const [nick, member] of members) {
            if (nick !== sender.nick) {
                fn(member);
            }
        }
    }
}
