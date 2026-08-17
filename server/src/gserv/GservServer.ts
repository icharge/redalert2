import { ServerConfig } from "../config";
import { Logger, makeLogger, fileLogOptionsOf } from "../logger";
import { GservInstance, GservManager } from "./GservManager";
import { SocketLike } from "../server/SocketLike";
import { isValidNickChars, stripCrlf } from "../protocol/validate";
import { TokenBucket } from "../util/rateLimit";
import { basename } from "node:path";
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

/**
 * Fired when a game finalizes and its replay (if any) has been written.
 * Lets the match archive record public games and their replay file names.
 */
export interface MatchArchivedEvent {
    gameId: string;
    timestamp: number;
    players: string[];
    replayFileName: string;
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
    // Complete per-turn relayed blobs, keyed by turn number, retained so a
    // rejoining player can re-simulate the match from turn 0.
    turnLog: Map<number, Map<number, Uint8Array>>;
    // Nick -> expiry (ms) of the rejoin grace window for players who dropped
    // mid-game. While present, the nick stays in requiredNicks so the relay
    // holds (the game pauses) until they rejoin or the window expires.
    departedAt: Map<string, number>;
    // Nicks admitted back into a started instance who have not yet finished
    // catching up (sent "ready"). Their action submissions are ignored.
    rejoiningNicks: Set<string>;
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
            this.runSweepPass();
        }, SWEEP_INTERVAL_MS);
        if (this.config.gservStatsIntervalSeconds > 0) {
            this.statsInterval = setInterval(() => {
                for (const line of this.buildStatsLines()) {
                    this.log.info(line);
                }
            }, this.config.gservStatsIntervalSeconds * 1000);
        }
    }

    // One periodic maintenance pass: expires instances that never started,
    // aborts loading instances whose departed players never rejoined, ends
    // expired mid-game rejoin windows, and finalizes empty instances. Public
    // so tests can drive the maintenance deterministically.
    runSweepPass(nowMs: number = Date.now()): void {
        const nowSeconds = Math.floor(nowMs / 1000);
        const removed = this.manager.sweepExpired(this.config.instanceTtlSeconds, this.config.gservReportWindowSeconds, nowSeconds);
        if (removed > 0) {
            this.log.info(`swept ${removed} expired gserv instance(s)`);
        }
        const aborted = this.abortStalledLoadingInstances(nowSeconds);
        if (aborted > 0) {
            this.log.info(`aborted ${aborted} instance(s) that never started in time`);
        }
        const loadingAborted = this.expireLoadingDepartures(nowSeconds);
        if (loadingAborted > 0) {
            this.log.info(`aborted ${loadingAborted} instance(s) whose departed players never rejoined`);
        }
        for (const [gameId, state] of [...this.instanceStates]) {
            this.expireDeparted(state, gameId, nowMs);
            if (state.members.size === 0 && state.departedAt.size === 0) {
                this.finalizeInstance(gameId, state);
            }
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
            const members = this.instanceMembers.get(gameId);
            // Delete by identity so an older socket closing can't evict a newer
            // connection that re-joined with the same nick.
            if (members?.get(client.nick) === client) {
                members.delete(client.nick);
            }
            const state = this.instanceStates.get(gameId);
            if (state) {
                if (state.requiredNicks.has(client.nick)) {
                    // Required player dropped mid-game: open the rejoin grace
                    // window. They stay in requiredNicks so the relay holds and
                    // the game pauses until they rejoin (resync) or the window
                    // expires (backfill + continue, see expireDeparted).
                    state.departedAt.set(client.nick, Date.now() + this.config.reconnectGraceSeconds * 1000);
                    this.log.info(`player ${client.nick} dropped mid-game; rejoin window opened for instance ${gameId}`);
                    this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_RECONNECTING} ${client.nick} :${client.nick}`);
                }
                else {
                    // Observers / passive players are not required by the relay;
                    // they simply leave.
                    this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_DISCONNECT} ${client.nick} :${client.nick}`);
                }
                state.rejoiningNicks.delete(client.nick);
            }
            else {
                // Loading phase: grant the departed player a grace window to
                // rejoin instead of aborting the instance immediately. The
                // sweep aborts it if they never come back.
                const instance = this.manager.get(gameId);
                if (instance) {
                    instance.loadingDepartures.set(client.nick, Math.floor(Date.now() / 1000) + this.config.loadingDepartureGraceSeconds);
                    this.log.info(`player ${client.nick} disconnected while loading; grace window opened for instance ${gameId}`);
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
            case "ready":
                this.handleReady(client, parts);
                break;
            case "loadinfo":
                this.handleLoadInfo(client);
                break;
            case "active":
                this.handleActive(client, parts[1] === "1");
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
        if (instance.started) {
            this.handleRejoin(client, instance, gameId);
            return;
        }
        client.instance = instance;
        let members = this.instanceMembers.get(gameId);
        if (!members) {
            members = new Map();
            this.instanceMembers.set(gameId, members);
        }
        if (members.size === 0 && instance.loadingSince === undefined) {
            instance.loadingSince = Math.floor(Date.now() / 1000);
        }
        members.set(client.nick, client);
        instance.loadingDepartures.delete(client.nick);
        this.log.info(`join instance ${gameId} as ${client.nick}`);
        client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_CONNECTED} ${client.nick} :connected\r\n`);
        this.broadcastLoadInfo(instance);
    }

    private handleRejoin(client: GservClient, instance: GservInstance, gameId: string): void {
        // Mid-game rejoin is only open to the original roster; the reloaded
        // client keeps its ticket (tickets are never consumed on join).
        if (!instance.players.includes(client.nick)) {
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_ALREADY_STARTED} ${client.nick} :instance already started\r\n`);
            return;
        }
        const state = this.instanceStates.get(gameId);
        if (!state) {
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_NONEXISTENT} ${client.nick} :no such instance\r\n`);
            return;
        }
        client.instance = instance;
        let members = this.instanceMembers.get(gameId);
        if (!members) {
            members = new Map();
            this.instanceMembers.set(gameId, members);
        }
        members.set(client.nick, client);
        state.departedAt.delete(client.nick);
        state.rejoiningNicks.add(client.nick);
        this.log.info(`rejoin instance ${gameId} as ${client.nick} (resync to turn ${state.lastTurnNo})`);
        client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_CONNECTED} ${client.nick} :connected\r\n`);
        client.socket.send(`:${this.serverName} ${Code.RPL_NET_RATE} ${client.nick} :${this.config.netRateMs},0\r\n`);
        this.sendResyncLog(state, client);
    }

    private sendResyncLog(state: InstanceState, client: GservClient): void {
        const lastTurnNo = state.lastTurnNo;
        client.socket.send(`:${this.serverName} ${Code.RPL_RESYNC} ${client.nick} :${lastTurnNo}\r\n`);
        for (let turnNo = 0; turnNo <= lastTurnNo; turnNo++) {
            const entries = state.turnLog.get(turnNo);
            if (!entries) {
                continue;
            }
            const payload = serializeAllPlayerActionBlobs(entries);
            const frame = new Uint8Array(6 + payload.length);
            frame[0] = Code.RPL_BIN_PREFIX;
            frame[1] = Code.RPL_BIN_RESYNC;
            new DataView(frame.buffer).setUint32(2, turnNo, true);
            frame.set(payload, 6);
            client.socket.send(frame);
        }
        this.log.info(`sent resync log (${lastTurnNo + 1} turns) to ${client.nick} for instance ${client.instance?.gameId}`);
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
        this.broadcastLoadInfo(client.instance);
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
        // Tickets are deliberately NOT cleared here: they stay valid so a
        // departed player can re-login and rejoin mid-game (reconnect). They
        // are dropped when the instance retires or is deleted.
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
            turnLog: new Map(),
            departedAt: new Map(),
            rejoiningNicks: new Set(),
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

    private handleActive(client: GservClient, active: boolean): void {
        client.active = active;
        if (active || !client.instance) {
            return;
        }
        const state = this.instanceStates.get(client.instance.gameId);
        if (!state) {
            return;
        }
        if (!state.requiredNicks.delete(client.nick)) {
            return;
        }
        this.log.info(`player ${client.nick} went passive; no longer required for turn relay`);
        const playerId = state.recorder.playerIdFor(client.nick);
        if (playerId !== undefined) {
            for (const submissions of state.pending.values()) {
                if (!submissions.has(client.nick)) {
                    submissions.set(client.nick, { playerId, blob: NO_ACTION_BLOB });
                }
            }
        }
        this.flushPendingTurns(state);
    }

    private handleReady(client: GservClient, parts: string[]): void {
        if (!client.instance) {
            return;
        }
        const state = this.instanceStates.get(client.instance.gameId);
        if (!state) {
            return;
        }
        const rejoining = state.rejoiningNicks.delete(client.nick);
        const turnNo = Number(parts[1] ?? state.lastTurnNo);
        if (turnNo !== state.lastTurnNo) {
            this.log.warn(`rejoin ${client.nick} reported ready at turn ${turnNo}, relay is at turn ${state.lastTurnNo}`);
        }
        const playerId = state.recorder.playerIdFor(client.nick);
        if (playerId !== undefined && !state.recorder.isObserver(client.nick)) {
            state.requiredNicks.add(client.nick);
        }
        state.departedAt.delete(client.nick);
        if (rejoining || playerId !== undefined) {
            this.log.info(`player ${client.nick} rejoined at turn ${turnNo}`);
            this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_RECONNECTED} ${client.nick} :${client.nick}`);
        }
    }

    // Ends the rejoin grace windows that have expired: backfills the departed
    // players' missing submissions with NoAction and removes them from the
    // relay requirement so the game can continue.
    private expireDeparted(state: InstanceState, gameId: string, nowMs: number = Date.now()): boolean {
        let expired = false;
        for (const [nick, expiry] of [...state.departedAt.entries()]) {
            if (nowMs < expiry) {
                continue;
            }
            state.departedAt.delete(nick);
            state.rejoiningNicks.delete(nick);
            expired = true;
            const playerId = state.recorder.playerIdFor(nick);
            if (playerId !== undefined) {
                for (const submissions of state.pending.values()) {
                    if (!submissions.has(nick)) {
                        submissions.set(nick, { playerId, blob: NO_ACTION_BLOB });
                    }
                }
            }
            state.requiredNicks.delete(nick);
            this.log.info(`rejoin grace expired for ${nick} in instance ${gameId}; continuing without them`);
            this.broadcastAll(state, `:${this.serverName} ${Code.RPL_PLAYER_GAVE_UP} ${nick} :${nick}`);
        }
        if (expired) {
            this.flushPendingTurns(state);
        }
        return expired;
    }

    // Aborts loading instances whose departed players did not rejoin within the
    // loading grace window: the remaining players would otherwise sit on the
    // loading screen forever.
    private expireLoadingDepartures(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
        let aborted = 0;
        for (const instance of this.manager.instances.values()) {
            if (instance.started || instance.loadingDepartures.size === 0) {
                continue;
            }
            for (const [nick, expiry] of instance.loadingDepartures) {
                if (nowSeconds <= expiry) {
                    continue;
                }
                this.log.warn(`aborting instance ${instance.gameId}: ${nick} did not rejoin before the loading grace expired`);
                const members = this.instanceMembers.get(instance.gameId);
                for (const member of members?.values() ?? []) {
                    member.socket.close(4003, "A player disconnected before the game started");
                }
                members?.clear();
                this.manager.deleteInstance(instance.gameId);
                aborted += 1;
                break;
            }
        }
        return aborted;
    }

    private broadcastAll(state: InstanceState, line: string): void {
        for (const member of state.members.values()) {
            member.socket.send(line);
        }
    }

    private handleLoadInfo(client: GservClient): void {
        if (!client.instance) {
            return;
        }
        this.sendLoadInfo(client.instance, client);
    }

    private sendLoadInfo(instance: GservInstance, target: GservClient): void {
        const members = this.instanceMembers.get(instance.gameId);
        const lines: string[] = [];
        for (const nick of instance.players) {
            const member = members?.get(nick);
            const status = member ? 1 : 0;
            const loaded = member?.loaded ?? 0;
            lines.push(`${nick},${status},${loaded},0,0,0`);
        }
        target.socket.send(`:${this.serverName} ${Code.RPL_LOAD_INFO} ${target.nick} :${lines.join(",")}\r\n`);
    }

    private broadcastLoadInfo(instance: GservInstance, excludedNick?: string): void {
        const members = this.instanceMembers.get(instance.gameId);
        if (!members) {
            return;
        }
        for (const member of members.values()) {
            if (member.nick !== excludedNick) {
                this.sendLoadInfo(instance, member);
            }
        }
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
        const targets = line.slice(8, sep).trim().split(",").map(target => target.trim()).filter(Boolean);
        const text = stripCrlf(line.slice(sep + 2));
        for (const target of targets) {
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
        this.expireDeparted(state, client.instance.gameId);
        if (state.rejoiningNicks.has(client.nick)) {
            this.log.debug(`ignoring actions from ${client.nick}: still rejoining`);
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
        state.turnLog.set(turnNo, new Map(entries));
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
        // Keep the instance metadata (roster, ranked flag) around until the
        // report-window sweep so the game-res report arriving right after the
        // last player disconnects can still be validated against it.
        this.manager.retireInstance(gameId);
        if (!state.recorder.hasEvents) {
            this.log.debug(`instance ${gameId} ended with no events; skipping replay`);
            return;
        }
        try {
            const filePath = state.recorder.finalize();
            this.log.info(`saved replay for instance ${gameId}: ${filePath}`);
            if (this.onMatchArchived) {
                const instance = this.manager.get(gameId);
                this.onMatchArchived({
                    gameId,
                    timestamp: instance?.timestamp ?? Math.floor(Date.now() / 1000),
                    players: instance?.players ?? [],
                    replayFileName: basename(filePath),
                });
            }
        }
        catch (error) {
            this.log.error(`failed to save replay for instance ${gameId}: ${(error as Error).message}`);
        }
    }

    /** Called with the written replay file name whenever a game finalizes. */
    onMatchArchived?: (event: MatchArchivedEvent) => void;

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
