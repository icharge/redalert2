import { ServerConfig } from "../config";
import { Logger, makeLogger, fileLogOptionsOf } from "../logger";
import { GservInstance, GservManager } from "./GservManager";
import { SocketLike } from "../server/SocketLike";
import { isValidNickChars, stripCrlf } from "../protocol/validate";
import { TokenBucket } from "../util/rateLimit";
import * as Code from "../protocol/gservCodes";
import { GSERV_SERVER_NAME } from "../protocol/replies";
import { GservReplayRecorder } from "./replay/GservReplayRecorder";
import {
    NO_ACTION_ID,
    serializeAllPlayerActionBlobs,
    serializePlayerActions,
} from "./replay/gameoptCodec";

export interface GservClient {
    socket: SocketLike;
    nick: string;
    authenticated: boolean;
    instance?: GservInstance;
    loaded: number;
    active: boolean;
    rateBucket?: TokenBucket;
}

// Gameplay sends at most one binary frame per network turn (~30/s at the
// default 33ms net rate, ~60/s at the fastest practical 16ms rate). The bucket
// leaves 3x+ headroom so only floods are dropped.
const GSERV_RATE_CAPACITY = 600;
const GSERV_RATE_REFILL_PER_SEC = 200;
const MAX_LINES_PER_FRAME = 32;
const MAX_LINE_LENGTH = 16 * 1024;
const MAX_BINARY_FRAME_BYTES = 64 * 1024;
const TURN_WINDOW = 8;
const MAX_PENDING_TURNS = 16;
const SWEEP_INTERVAL_MS = 30_000;

const NO_ACTION_BLOB = serializePlayerActions([{ id: NO_ACTION_ID, params: new Uint8Array() }]);

interface PendingSubmission {
    playerId: number;
    blob: Uint8Array;
}

// Live per-instance counters, reset every stats interval to report real
// frames/s and ticks/s during play.
interface InstanceStats {
    windowStart: number;
    framesByNick: Map<string, number>;
    framesTotal: number;
    ticks: number;
}

interface InstanceState {
    recorder: GservReplayRecorder;
    members: Map<string, GservClient>;
    requiredNicks: Set<string>;
    pending: Map<number, Map<string, PendingSubmission>>;
    lastTurnNo: number;
    stats: InstanceStats;
}

export class GservServer {
    readonly serverName = GSERV_SERVER_NAME;
    readonly log: Logger;
    private clients = new Map<SocketLike, GservClient>();
    private instanceMembers = new Map<string, Map<string, GservClient>>();
    private instanceStates = new Map<string, InstanceState>();
    private sweepInterval?: ReturnType<typeof setInterval>;
    private statsInterval?: ReturnType<typeof setInterval>;

    constructor(
        private config: ServerConfig,
        private manager: GservManager,
    ) {
        this.log = makeLogger(config.logLevel, "gserv", fileLogOptionsOf(config));
    }

    startSweepLoop(): void {
        if (this.sweepInterval) {
            return;
        }
        this.sweepInterval = setInterval(() => {
            const removed = this.manager.sweepExpired(this.config.instanceTtlSeconds);
            if (removed > 0) {
                this.log.info(`swept ${removed} expired gserv instance(s)`);
            }
            const aborted = this.abortStalledLoadingInstances();
            if (aborted > 0) {
                this.log.info(`aborted ${aborted} instance(s) that never started in time`);
            }
        }, SWEEP_INTERVAL_MS);
        if (this.config.gservStatsIntervalSeconds > 0) {
            this.statsInterval = setInterval(() => {
                for (const line of this.buildStatsLines()) {
                    this.log.info(line);
                }
            }, this.config.gservStatsIntervalSeconds * 1000);
        }
    }

    dispose(): void {
        if (this.sweepInterval) {
            clearInterval(this.sweepInterval);
            this.sweepInterval = undefined;
        }
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = undefined;
        }
    }

    // One line per active game every stats interval, e.g.:
    //   instance g1-abcd1234: 2 player(s), 30 ticks/s, 62 frames/s (alice=31/s bob=31/s)
    // Frames are action frames received from each player; ticks are turns
    // relayed. Counters reset after each line, so the numbers are true rates.
    private buildStatsLines(nowMs: number = Date.now()): string[] {
        const lines: string[] = [];
        for (const [gameId, state] of this.instanceStates) {
            if (state.members.size === 0) {
                continue;
            }
            const elapsed = (nowMs - state.stats.windowStart) / 1000;
            if (elapsed <= 0) {
                continue;
            }
            const ticksPerSec = Math.round(state.stats.ticks / elapsed);
            const framesPerSec = Math.round(state.stats.framesTotal / elapsed);
            const perPlayer = [...state.stats.framesByNick.entries()]
                .map(([nick, frames]) => `${nick}=${Math.round(frames / elapsed)}/s`)
                .join(" ");
            lines.push(
                `instance ${gameId}: ${state.members.size} player(s), ${ticksPerSec} ticks/s, ${framesPerSec} frames/s (${perPlayer})`,
            );
            state.stats.windowStart = nowMs;
            state.stats.ticks = 0;
            state.stats.framesTotal = 0;
            state.stats.framesByNick.clear();
        }
        return lines;
    }

    handleOpen(socket: SocketLike): GservClient {
        const client: GservClient = {
            socket,
            nick: "*",
            authenticated: false,
            loaded: 0,
            active: true,
            rateBucket: this.config.gservRateLimitEnabled
                ? new TokenBucket(GSERV_RATE_CAPACITY, GSERV_RATE_REFILL_PER_SEC)
                : undefined,
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
            // Delete by identity so an older socket closing can't evict a newer
            // connection that re-joined with the same nick.
            if (members?.get(client.nick) === client) {
                members.delete(client.nick);
            }
            const state = this.instanceStates.get(gameId);
            if (state) {
                state.requiredNicks.delete(client.nick);
                // If a member dropped without submitting a pending turn, treat their
                // missing submissions as NoAction so the game can keep advancing.
                const playerId = state.recorder.playerIdFor(client.nick);
                if (playerId !== undefined) {
                    for (const submissions of state.pending.values()) {
                        if (!submissions.has(client.nick)) {
                            submissions.set(client.nick, { playerId, blob: NO_ACTION_BLOB });
                        }
                    }
                }
                this.flushPendingTurns(state);
                if (!members || members.size === 0) {
                    this.finalizeInstance(gameId, state);
                }
            }
            else if (members && members.size > 0) {
                // A player dropped while the game was still loading. The instance
                // can no longer start (the game waits for every player to join and
                // the departed player's ticket is already spent), so abort it:
                // disconnect the rest instead of leaving them on a frozen
                // loading screen.
                this.log.info(`aborting instance ${gameId}: ${client.nick} disconnected before game start`);
                for (const member of members.values()) {
                    member.socket.close(4003, "A player disconnected before the game started");
                }
                members.clear();
                this.manager.deleteInstance(gameId);
            }
            else if (members && members.size === 0) {
                this.manager.deleteInstance(gameId);
            }
        }
        else {
            this.log.debug("gserv connection closed (not authenticated)");
        }
        this.clients.delete(client.socket);
    }

    handleMessage(client: GservClient, message: string | Uint8Array): void {
        if (typeof message !== "string") {
            this.handleBinary(client, message);
            return;
        }
        let processed = 0;
        for (const line of message.split(/\r?\n/)) {
            if (processed >= MAX_LINES_PER_FRAME) {
                this.log.warn(`dropping frame: too many lines from ${client.nick}`);
                break;
            }
            processed += 1;
            if (line.length > MAX_LINE_LENGTH) {
                this.log.warn(`dropping frame: line too long from ${client.nick}`);
                break;
            }
            if (line.length && client.rateBucket && !client.rateBucket.tryTake()) {
                this.log.warn(`rate limit exceeded for ${client.nick}; dropping connection`);
                client.socket.close(4008, "Rate limit exceeded");
                break;
            }
            if (line.length) {
                this.handleLine(client, stripCrlf(line));
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

    // Instances that gathered at least one player but never started within the
    // configured timeout are aborted: without this the remaining players would
    // sit on the loading screen forever whenever a roster player never joins.
    // (Instances nobody ever joined are left to sweepExpired.)
    private abortStalledLoadingInstances(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
        let aborted = 0;
        for (const instance of this.manager.instances.values()) {
            if (instance.started || instance.loadingSince === undefined) {
                continue;
            }
            if (nowSeconds - instance.loadingSince <= this.config.startTimeoutSeconds) {
                continue;
            }
            const members = this.instanceMembers.get(instance.gameId);
            if (!members || members.size === 0) {
                continue;
            }
            this.log.warn(`aborting instance ${instance.gameId}: did not start within ${this.config.startTimeoutSeconds}s`);
            for (const member of members.values()) {
                member.socket.close(4003, "Game did not start in time");
            }
            members.clear();
            this.manager.deleteInstance(instance.gameId);
            aborted += 1;
        }
        return aborted;
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
        this.manager.consumeTicketByNick(client.nick);
        let members = this.instanceMembers.get(gameId);
        if (!members) {
            members = new Map();
            this.instanceMembers.set(gameId, members);
        }
        if (members.size === 0 && instance.loadingSince === undefined) {
            instance.loadingSince = Math.floor(Date.now() / 1000);
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
        // The roster in instance.tickets is fixed at creation and never mutated,
        // and handleJoin only admits roster nicks, so a full member set means
        // every expected player has joined. Starting with a partial roster would
        // clear the tickets still needed by late players to log in.
        if (members.size < instance.tickets.size) {
            return;
        }
        if (![...members.values()].every(member => member.loaded >= 100)) {
            return;
        }
        instance.started = true;
        this.manager.clearTickets(instance.gameId);
        this.log.info(`instance ${instance.gameId} started`);
        const recorder = new GservReplayRecorder(instance, {
            gameVersion: this.config.gameVersion,
            modHash: this.config.expectedModHash,
            netRateMs: this.config.netRateMs,
            replaysDir: this.config.replaysDir,
            enabled: this.config.recordReplays,
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
            stats: {
                windowStart: Date.now(),
                framesByNick: new Map(),
                framesTotal: 0,
                ticks: 0,
            },
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
        const text = stripCrlf(line.slice(sep + 2));
        if (target === "#all" || target === "#team") {
            this.broadcastLine(client, `:${client.nick} PRIVMSG ${target} :${text}`);
            const state = client.instance ? this.instanceStates.get(client.instance.gameId) : undefined;
            state?.recorder.recordChat(client.nick, text);
        }
        else if (target !== client.nick && isValidNickChars(target)) {
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
        if (data.length > MAX_BINARY_FRAME_BYTES) {
            this.log.warn(`dropping oversized action frame from ${client.nick}`);
            return;
        }
        if (client.rateBucket && !client.rateBucket.tryTake()) {
            this.log.warn(`rate limit exceeded for ${client.nick}; dropping connection`);
            client.socket.close(4008, "Rate limit exceeded");
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
        if (turnNo <= state.lastTurnNo) {
            this.log.debug(`ignoring stale turn ${turnNo} from ${client.nick}`);
            return;
        }
        if (turnNo > state.lastTurnNo + TURN_WINDOW) {
            this.log.warn(`ignoring out-of-window turn ${turnNo} from ${client.nick}`);
            return;
        }
        if (state.pending.size >= MAX_PENDING_TURNS && !state.pending.has(turnNo)) {
            this.log.warn(`too many pending turns; ignoring turn ${turnNo} from ${client.nick}`);
            return;
        }
        let submissions = state.pending.get(turnNo);
        if (!submissions) {
            submissions = new Map();
            state.pending.set(turnNo, submissions);
        }
        submissions.set(client.nick, { playerId, blob: data.subarray(6) });
        state.stats.framesByNick.set(client.nick, (state.stats.framesByNick.get(client.nick) ?? 0) + 1);
        state.stats.framesTotal += 1;
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
        const entries = new Map<number, Uint8Array>();
        for (const submission of submissions.values()) {
            entries.set(submission.playerId, submission.blob);
        }
        state.recorder.recordTurn(turnNo, entries);
        const payload = serializeAllPlayerActionBlobs(entries);
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
        state.stats.ticks += 1;
        // this.log.debug(`relayed turn ${turnNo} (${entries.size} player(s))`);
    }

    private finalizeInstance(gameId: string, state: InstanceState): void {
        this.instanceStates.delete(gameId);
        this.manager.deleteInstance(gameId);
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
