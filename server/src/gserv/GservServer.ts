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
const STALE_TURN_LOG_INTERVAL_MS = 5_000;
// Sentinel departedAt deadline for abandonedInstanceTimeoutSeconds <= 0
// ("hold indefinitely"). A real (finite) timestamp rather than Infinity so it
// still round-trips through the LOAD_INFO wire format as an ordinary number;
// it's simply so far in the future expireDeparted never reaches it.
const ABANDONED_HOLD_INDEFINITELY_DEADLINE = Number.MAX_SAFE_INTEGER;

const NO_ACTION_BLOB = serializePlayerActions([{ id: NO_ACTION_ID, params: new Uint8Array() }]);
// ActionType.ResignGame (client: src/game/action/ActionType.ts). Injected for a
// departed player whose rejoin window expires: their assets are destroyed and
// they are marked defeated, exactly like a normal resign.
const RESIGN_GAME_ACTION_ID = 3;
const RESIGN_ACTION_BLOB = serializePlayerActions([{ id: RESIGN_GAME_ACTION_ID, params: new Uint8Array() }]);

interface PendingSubmission {
    playerId: number;
    blob: Uint8Array;
}

export type VoteChoice = "kick" | "wait";

// An open kick/wait vote on one departed player. Created by openVoteSession
// when they drop (if enough players remain to vote) and destroyed by
// closeVoteSession on any outcome: the kick carrying, the player reconnecting,
// or their grace window running out.
interface VoteSession {
    // Voter nick -> their choice. A cast vote is final: handleVote refuses a
    // second one from the same nick, so an entry here never changes value.
    votes: Map<string, VoteChoice>;
    // Remaining "wait" extensions. Each one buys the departed player another
    // voteExtensionSeconds; at zero, wait votes stop vetoing a kick majority.
    extensionsRemaining: number;
    // Wait voters who have already bought an extension, so each of them is
    // charged exactly once however many times the tally is recomputed.
    //
    // This is what replaced the older "spend on the 0 -> nonzero wait
    // transition" rule, which only worked while votes could be changed: with
    // final votes the wait count can never fall back to zero, so that rule
    // could only ever spend a single extension and any voteExtensionsMax above
    // 1 was dead config. Charging per distinct wait voter keeps the whole pool
    // reachable and states the rule plainly -- each player voting wait buys
    // voteExtensionSeconds, up to voteExtensionsMax of them.
    chargedWaitVoters: Set<string>;
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
    // Nicks that just finished rejoining (sent "ready") and are waiting for
    // the resume countdown to actually fire. A rejoiner's LockstepManager
    // holds off submitting anything live while it's still replaying from
    // turn 0 to catch up (setSuppressNetworkSends) -- so any turn another
    // player kept submitting (unconfirmed) to state.pending *while* this
    // nick was rejoining can never pick up this nick's entry on its own.
    // See schedulePauseTimer's resume branch, which backfills exactly these
    // turns with NO_ACTION_BLOB before flushing, mirroring the same
    // backfill handlePassive/handleLeave already do when a player stops
    // being required entirely.
    pendingRejoinBackfill: Set<string>;
    // Nicks that voluntarily left (handleLeave) rather than just dropping.
    // Unlike a dropped/timed-out player, tickets and instance.players are
    // unchanged, so without this a "leave" would be silently undone by a
    // later join with the same ticket — handleRejoin checks this and refuses.
    leftNicks: Set<string>;
    // Open kick/wait votes, keyed by the departed player they are about. Only
    // populated when isVotingEligible() held at the moment that player dropped,
    // so a 1v1 simply never has any and needs no special-casing anywhere else
    // (including on the client, which renders vote controls only for nicks that
    // appear here).
    voteSessions: Map<string, VoteSession>;
    // Nick -> the pending "should we open a vote on them" timer, scheduled by
    // scheduleVoteOpen() the moment they drop and cancelled the moment they
    // come back (handleRejoin) or stop being a departure at all (expireDeparted,
    // handleLeave). A voteSessions entry never exists for a nick that still has
    // one of these pending -- the timer firing (still-departed) is what
    // actually calls openVoteSession.
    pendingVoteOpens: Map<string, ReturnType<typeof setTimeout>>;
    // Whole-game pause (MOBA-style). While paused the relay holds and every
    // client freezes; resume flushes the small accumulated backlog.
    paused: boolean;
    // Set to Date.now() when `paused` becomes true, cleared on resume. Used to
    // shift departedAt deadlines forward by the paused duration so a manual
    // pause doesn't silently burn through a departed player's rejoin grace
    // window (see schedulePauseTimer).
    pausedAt?: number;
    pauseCountdownUntil?: number;
    resumeCountdownUntil?: number;
    pauseTimer?: ReturnType<typeof setTimeout>;
    lastPauseByNick: Map<string, number>;
    lastStaleLogByNick: Map<string, number>;
    // Latest per-turn state hashes from each client (REQ_BIN_GAME_STATE_HASH);
    // compared to surface silent desyncs as a fatal error.
    hashByTurn: Map<number, Map<string, number>>;
    desyncReported: boolean;
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

    // A live instance's replay serialized up to right now, for an
    // auto-submitted error report to attach (see routes.ts's
    // handleErrorReport) -- well before the instance's normal end-of-game
    // finalize() writes an .rpl file to disk, which on a desync doesn't
    // happen until both players' rejoin windows expire (see
    // finalizeInstance's `state.members.size === 0 && state.departedAt.size
    // === 0` guard). Returns undefined when there's no live instance for
    // this gameId, or nothing worth attaching yet (recording disabled, or
    // no turns captured -- hasEvents covers both: recordTurn() no-ops
    // entirely when the recorder is disabled, so events never accumulate).
    getReplaySnapshot(gameId: string): string | undefined {
        const state = this.instanceStates.get(gameId);
        if (!state || !state.recorder.hasEvents) {
            return undefined;
        }
        return state.recorder.serialize();
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
                if (this.isRequiredRosterPlayer(state, client.nick)) {
                    // Required player dropped mid-game: open the rejoin grace
                    // window. They stay in requiredNicks so the relay holds and
                    // the game pauses until they rejoin (resync) or the window
                    // expires (resign + continue, see expireDeparted).
                    //
                    // Re-add unconditionally (a no-op if they were already
                    // there): a browser tab-close fires visibilitychange
                    // (hidden) before the socket actually closes
                    // (GameAnimationLoop.handleVisibilityChange), which sends
                    // "active 0" and makes handleActive() remove them from
                    // requiredNicks moments before this handler runs -- found
                    // via manual multiplayer testing that a closed tab was
                    // silently falling into the observer/passive branch below
                    // (no grace window, no pause, no RPL_PLAYER_RECONNECTING)
                    // instead of a real disconnect, for exactly this reason.
                    // Passive only ever means "temporarily excused from
                    // submitting frames while backgrounded", never "no longer
                    // a required player" -- isRequiredRosterPlayer(), unlike
                    // requiredNicks itself, is unaffected by that flag.
                    state.requiredNicks.add(client.nick);
                    state.departedAt.set(client.nick, Date.now() + this.config.reconnectGraceSeconds * 1000);
                    this.log.info(`player ${client.nick} dropped mid-game; rejoin window opened for instance ${gameId}`);
                    this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_DISCONNECT} ${client.nick} :${client.nick}`);
                    this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_RECONNECTING} ${client.nick} :${client.nick}`);
                    // Offer the remaining players a kick/wait vote, so they can
                    // cut the wait short or buy the departed player more time
                    // instead of being locked into the fixed grace window --
                    // but only once voteOpenDelayMillis has passed with them
                    // still gone (see scheduleVoteOpen): most drops resolve
                    // themselves in a few seconds and shouldn't force a vote.
                    // No-ops in games too small to vote fairly.
                    this.scheduleVoteOpen(state, gameId, client.nick);
                }
                else {
                    // Observers / passive players are not required by the relay;
                    // they simply leave.
                    this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_DISCONNECT} ${client.nick} :${client.nick}`);
                }
                state.rejoiningNicks.delete(client.nick);
                // This player just left the electorate of every *other* open
                // vote, which lowers those majority thresholds. Re-tally them
                // so a vote that is now decided resolves immediately instead of
                // sitting until someone happens to cast another vote. Iterated
                // over a copy because resolving deletes from voteSessions.
                for (const targetNick of [...state.voteSessions.keys()]) {
                    if (targetNick !== client.nick) {
                        this.resolveVote(state, gameId, targetNick);
                    }
                }
                this.extendAbandonedInstanceDeadlines(state, gameId);
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
            case "pause":
                this.handlePause(client);
                break;
            case "resume":
                this.handleResume(client);
                break;
            case "vote":
                this.handleVote(client, parts);
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
            case "leave":
                this.handleLeave(client);
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
        if (version && !this.isVersionCompatible(version, this.config.gameVersion)) {
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
        if (state.leftNicks.has(client.nick)) {
            // Voluntarily left (handleLeave): permanent, unlike a drop/timeout
            // — the ticket and roster entry are deliberately left intact for
            // those cases, but a deliberate leave must not be reversible by
            // simply reconnecting with the same ticket.
            client.socket.send(`:${this.serverName} ${Code.RPL_INSTANCE_NOT_ALLOWED} ${client.nick} :left the game\r\n`);
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
        // They made it back on their own -- there is nothing left to vote on,
        // whether a vote was already open (closeVoteSession) or was still
        // waiting out voteOpenDelayMillis before ever opening one
        // (cancelPendingVoteOpen) -- this is the common case: most drops
        // resolve as a reconnect well within that delay, and should never
        // surface a vote at all. Closed here rather than on
        // RPL_PLAYER_RECONNECTED, which does not fire until handleReady (i.e.
        // after the entire turn-0 replay), so the vote UI would otherwise sit
        // open for the whole catch-up.
        this.closeVoteSession(state, client.nick);
        this.cancelPendingVoteOpen(state, client.nick);
        state.rejoiningNicks.add(client.nick);
        // A stuck rejoiner must not hold the relay forever: the sweep expires
        // them from the rejoin window (backfill + continue) if they never ready.
        state.departedAt.set(client.nick, Date.now() + this.config.reconnectGraceSeconds * 1000);
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
            pendingRejoinBackfill: new Set(),
            leftNicks: new Set(),
            voteSessions: new Map(),
            pendingVoteOpens: new Map(),
            paused: false,
            lastPauseByNick: new Map(),
            lastStaleLogByNick: new Map(),
            hashByTurn: new Map(),
            desyncReported: false,
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
        if (!client.instance) {
            return;
        }
        const state = this.instanceStates.get(client.instance.gameId);
        if (!state) {
            return;
        }
        if (active) {
            // Mirrors the requiredNicks.add() in handleReady: a non-observer
            // player coming back from passive (e.g. GameAnimationLoop marking
            // them passive while their tab was backgrounded) must be required
            // for the relay again, or their turns are permanently rejected as
            // stale from here on and their input silently stops applying.
            if (!state.rejoiningNicks.has(client.nick)) {
                const playerId = state.recorder.playerIdFor(client.nick);
                if (playerId !== undefined && !state.recorder.isObserver(client.nick)) {
                    state.requiredNicks.add(client.nick);
                }
            }
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

    // Sent by a client that is deliberately quitting ("Abort Mission"), right
    // before it closes the connection. Unlike an accidental disconnect
    // (handleClose), this nick must not get a rejoin grace window: it is
    // removed from requiredNicks immediately and for good, exactly like a
    // timed-out rejoin (expireDeparted), just without waiting for the timeout.
    private handleLeave(client: GservClient): void {
        if (!client.instance) {
            return;
        }
        const state = this.instanceStates.get(client.instance.gameId);
        if (!state) {
            return;
        }
        state.departedAt.delete(client.nick);
        state.rejoiningNicks.delete(client.nick);
        state.leftNicks.add(client.nick);
        this.closeVoteSession(state, client.nick);
        this.cancelPendingVoteOpen(state, client.nick);
        if (!state.requiredNicks.delete(client.nick)) {
            return;
        }
        this.log.info(`player ${client.nick} left instance ${client.instance.gameId} voluntarily; resigning them`);
        const playerId = state.recorder.playerIdFor(client.nick);
        if (playerId !== undefined) {
            for (const submissions of state.pending.values()) {
                if (!submissions.has(client.nick)) {
                    submissions.set(client.nick, { playerId, blob: NO_ACTION_BLOB });
                }
            }
        }
        this.flushPendingTurns(state);
        this.broadcastAll(state, `:${this.serverName} ${Code.RPL_PLAYER_GAVE_UP} ${client.nick} :${client.nick}`);
    }

    // True while any required (non-observer) player is either still fully
    // departed or has reconnected but not yet finished catching up. Used both
    // to hold the relay and to decide whether it is safe to declare the game
    // "resumed" — with two or more players down at once, the first one to
    // ready up must not trigger a resume broadcast while another is still
    // away, or every client sees a false "Game Resumed" while the relay stays
    // frozen waiting on the straggler.
    private hasAbsentRequiredPlayers(state: InstanceState): boolean {
        for (const nick of state.departedAt.keys()) {
            if (state.recorder.playerIdFor(nick) !== undefined && !state.recorder.isObserver(nick)) {
                return true;
            }
        }
        for (const nick of state.rejoiningNicks) {
            if (state.recorder.playerIdFor(nick) !== undefined && !state.recorder.isObserver(nick)) {
                return true;
            }
        }
        return false;
    }

    // Compares a client-submitted "major.minor.patch-githash" version string
    // against this.config.gameVersion. If the configured expected version
    // carries a git-hash suffix, the match must be exact (same build) --
    // deterministic lockstep means even two builds of the same patch could
    // in principle differ in game logic, so an operator who wants that
    // guarantee sets GAME_VERSION to the exact build they deployed (e.g.
    // "0.83.4-a1b2c3d"). If they left the hash off (the default,
    // "0.83.4"), only major.minor.patch need match, so any build of that
    // release can connect -- this keeps every existing deployment and test
    // that doesn't configure GAME_VERSION working exactly as before.
    private isVersionCompatible(clientVersion: string, expectedVersion: string): boolean {
        if (expectedVersion.includes("-")) {
            return clientVersion === expectedVersion;
        }
        return clientVersion.split("-")[0] === expectedVersion;
    }

    // Whether a departure in this instance should open a kick/wait vote at all.
    // Deliberately evaluated against the *live* requirement set rather than the
    // original lobby size: a 4-player game already whittled down to two active
    // players is, for voting purposes, a 1v1 -- and a "majority" of one player
    // deciding another's fate is exactly what the minimum exists to prevent.
    private isVotingEligible(state: InstanceState): boolean {
        return state.requiredNicks.size >= this.config.voteMinRequiredPlayers;
    }

    // Whether `nick` is a real (non-observer) roster player of this match who
    // is still in it -- independent of whether they are *currently* in
    // requiredNicks, which handleActive() empties for a player whose tab is
    // merely backgrounded (see handleClose's use of this: a passive player is
    // not less of a required player, they're just temporarily excused from
    // submitting frames while their tab is hidden).
    //
    // leftNicks is what excludes the players requiredNicks membership used to
    // exclude on its own: someone who quit (handleLeave) or was resigned
    // (resignDeparted) is off the roster for good. That matters most for the
    // voluntary quit, where handleLeave is always followed a moment later by
    // handleClose for the very same socket -- without this check that trailing
    // close would look like a fresh mid-game drop and freeze the relay for a
    // whole grace window waiting on a player who already resigned.
    private isRequiredRosterPlayer(state: InstanceState, nick: string): boolean {
        return !state.leftNicks.has(nick)
            && state.recorder.playerIdFor(nick) !== undefined
            && !state.recorder.isObserver(nick);
    }

    // Who may vote on `targetNick`'s departure: everyone still required by the
    // relay, still connected, and not themselves away -- excluding the target.
    // Recomputed fresh on every tally rather than snapshotted at session open,
    // so a second player dropping mid-vote falls out of both the electorate and
    // the majority threshold on the next recount, with no bookkeeping.
    private isEligibleVoter(state: InstanceState, nick: string, targetNick: string): boolean {
        return nick !== targetNick
            && state.requiredNicks.has(nick)
            && state.members.has(nick)
            && !state.departedAt.has(nick)
            && state.recorder.playerIdFor(nick) !== undefined
            && !state.recorder.isObserver(nick);
    }

    // Called the instant a required player drops. Does NOT open a vote yet --
    // most drops are a brief network blip that resolves itself well within
    // voteOpenDelayMillis, and nobody should be asked to weigh in on kicking a
    // player who is about to reconnect on their own. Schedules the actual
    // openVoteSession() call for later, and only if they are still gone by
    // then (cancelPendingVoteOpen, called on rejoin/resign/leave, is what
    // stops it from ever firing for a drop that resolves itself).
    private scheduleVoteOpen(state: InstanceState, gameId: string, targetNick: string): void {
        this.cancelPendingVoteOpen(state, targetNick);
        const timer = setTimeout(() => {
            state.pendingVoteOpens.delete(targetNick);
            // The instance could have finalized (e.g. everyone left) or this
            // exact state object could have been replaced by the time this
            // fires -- mirrors schedulePauseTimer's identical staleness guard.
            if (this.instanceStates.get(gameId) !== state || !state.departedAt.has(targetNick)) {
                return;
            }
            this.openVoteSession(state, gameId, targetNick);
        }, this.config.voteOpenDelayMillis);
        state.pendingVoteOpens.set(targetNick, timer);
    }

    // Cancels a not-yet-opened vote before it fires: the departure it was
    // scheduled for is no longer relevant, because the player came back, was
    // resigned outright, or voluntarily left. Safe to call when nothing is
    // pending, matching closeVoteSession's unconditional-caller style.
    private cancelPendingVoteOpen(state: InstanceState, targetNick: string): void {
        const timer = state.pendingVoteOpens.get(targetNick);
        if (timer === undefined) {
            return;
        }
        clearTimeout(timer);
        state.pendingVoteOpens.delete(targetNick);
    }

    private openVoteSession(state: InstanceState, gameId: string, targetNick: string): void {
        if (!this.isVotingEligible(state) || state.voteSessions.has(targetNick)) {
            return;
        }
        state.voteSessions.set(targetNick, {
            votes: new Map(),
            extensionsRemaining: this.config.voteExtensionsMax,
            chargedWaitVoters: new Set(),
        });
        this.log.info(`opened kick/wait vote on ${targetNick} in instance ${gameId}`);
        this.broadcastAll(
            state,
            `:${this.serverName} ${Code.RPL_VOTE_SESSION_OPENED} ${targetNick} ` +
            `:${targetNick},${this.config.voteExtensionsMax},${this.config.voteExtensionSeconds}`,
        );
        // Broadcast the opening (empty) tally through the same path a real vote
        // takes, so clients get their initial state without a second code path.
        this.resolveVote(state, gameId, targetNick);
    }

    // Ends a vote session for any reason (resolved, reconnected, timed out).
    // Safe to call when no session exists, which is what lets the callers stay
    // unconditional.
    private closeVoteSession(state: InstanceState, targetNick: string): void {
        if (!state.voteSessions.delete(targetNick)) {
            return;
        }
        this.broadcastAll(state, `:${this.serverName} ${Code.RPL_VOTE_SESSION_CLOSED} ${targetNick} :${targetNick}`);
    }

    private handleVote(client: GservClient, parts: string[]): void {
        const state = client.instance ? this.instanceStates.get(client.instance.gameId) : undefined;
        if (!state || !client.instance) {
            return;
        }
        const targetNick = parts[1];
        const choice = parts[2];
        if (choice !== "kick" && choice !== "wait") {
            return;
        }
        // No session means nothing to vote on -- a 1v1, a nick who isn't
        // actually away, or a vote that resolved a moment ago. Silently ignored
        // rather than answered with an error, exactly like the other
        // fire-and-forget commands.
        const session = state.voteSessions.get(targetNick);
        if (!session || !this.isEligibleVoter(state, client.nick, targetNick)) {
            return;
        }
        // A vote is final. Enforced here rather than only in the UI (which
        // stops offering the buttons once you have voted): otherwise a modified
        // client could flip between kick and wait to keep re-earning wait
        // extensions, which is exactly the abuse the per-voter extension charge
        // above is designed to rule out.
        if (session.votes.has(client.nick)) {
            return;
        }
        session.votes.set(client.nick, choice);
        this.resolveVote(state, client.instance.gameId, targetNick);
    }

    // Recomputes a vote's tally, spends an extension if this is the moment a
    // wait vote first appears, broadcasts the result, and resigns the target
    // early if a kick majority now carries unvetoed.
    private resolveVote(state: InstanceState, gameId: string, targetNick: string): void {
        const session = state.voteSessions.get(targetNick);
        if (!session) {
            return;
        }
        const eligible = [...state.requiredNicks].filter(nick => this.isEligibleVoter(state, nick, targetNick));
        // isVotingEligible() only gates *opening* a session, against
        // requiredNicks.size at that instant -- which does not shrink just
        // because other players are concurrently departed (only resigning or
        // leaving removes a nick from requiredNicks). So if a second required
        // player drops while this session is already open, `eligible` here can
        // fall well below what the original gate intended, letting as few as
        // one remaining player cast a unilateral "majority" kick -- exactly
        // what voteMinRequiredPlayers exists to prevent. Re-checked here on
        // every recount, using eligible.length + 1 (the +1 for the target
        // themself, who is still nominally required) as the same live count
        // isVotingEligible would see if evaluated fresh right now. Below the
        // floor, voting is no longer fair, so the session closes outright
        // (matching "2-player games get no voting UI at all") rather than
        // merely refusing to resolve -- any wait extension already granted
        // stands; only further voting stops.
        if (eligible.length + 1 < this.config.voteMinRequiredPlayers) {
            this.closeVoteSession(state, targetNick);
            return;
        }
        let kickVotes = 0;
        let waitVotes = 0;
        for (const nick of eligible) {
            const choice = session.votes.get(nick);
            if (choice === "kick") {
                kickVotes += 1;
            }
            else if (choice === "wait") {
                waitVotes += 1;
            }
        }
        const hasWaitVote = waitVotes > 0;
        // Every wait voter buys one extension, once. Charged here rather than
        // in handleVote so a voter who was ineligible when they voted (and so
        // did not count) cannot be charged, and so the ledger is driven by the
        // same freshly-recomputed electorate as the tally itself.
        for (const nick of eligible) {
            if (session.votes.get(nick) !== "wait"
                || session.chargedWaitVoters.has(nick)
                || session.extensionsRemaining <= 0) {
                continue;
            }
            session.chargedWaitVoters.add(nick);
            session.extensionsRemaining -= 1;
            const expiry = state.departedAt.get(targetNick);
            if (expiry !== undefined) {
                state.departedAt.set(targetNick, expiry + this.config.voteExtensionSeconds * 1000);
            }
            this.log.info(`${nick}'s wait vote extended ${targetNick}'s rejoin window in instance ${gameId} ` +
                `(${session.extensionsRemaining} extension(s) left)`);
        }
        const majorityThreshold = Math.floor(eligible.length / 2) + 1;
        // Read *after* the charges above: the wait vote that drains the last
        // extension does not itself veto, since by the time it is resolved the
        // pool is empty and wait votes are advisory.
        const vetoActive = hasWaitVote && session.extensionsRemaining > 0;
        const resolved = eligible.length > 0 && kickVotes >= majorityThreshold && !vetoActive;
        const ballot = eligible
            .filter(nick => session.votes.has(nick))
            .map(nick => `${nick}=${session.votes.get(nick)}`)
            .join(";");
        this.broadcastAll(
            state,
            `:${this.serverName} ${Code.RPL_VOTE_UPDATE} ${targetNick} ` +
            `:${targetNick},${kickVotes},${waitVotes},${session.extensionsRemaining},` +
            `${eligible.length},${majorityThreshold},${ballot}`,
        );
        if (resolved) {
            this.resignDepartedPlayerEarly(state, gameId, targetNick);
        }
    }

    // A kick vote carried: end the departure now instead of waiting out the
    // rest of the grace window. Same outcome, and the same code, as the window
    // expiring naturally.
    private resignDepartedPlayerEarly(state: InstanceState, gameId: string, nick: string): void {
        state.departedAt.delete(nick);
        state.rejoiningNicks.delete(nick);
        this.closeVoteSession(state, nick);
        this.resignDeparted(state, gameId, nick, "kick vote passed");
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
        if (rejoining) {
            state.pendingRejoinBackfill.add(client.nick);
            this.broadcastLine(client, `:${this.serverName} ${Code.RPL_PLAYER_RECONNECTED} ${client.nick} :${client.nick}`);
            if (this.hasAbsentRequiredPlayers(state)) {
                // Someone else who dropped is still away or still catching up:
                // starting the resume countdown now would broadcast a false
                // "resumed" to everyone while the relay keeps holding on the
                // straggler. Wait for the last one back to trigger it.
                this.log.info(`player ${client.nick} rejoined at turn ${turnNo}; still waiting on other departed player(s) in instance ${client.instance.gameId}`);
                return;
            }
            this.log.info(`player ${client.nick} rejoined at turn ${turnNo}; resuming in ${this.config.rejoinResumeCountdownMillis}ms`);
            // Everyone is synced; run a short countdown before the relay
            // resumes so all players are ready.
            state.resumeCountdownUntil = Date.now() + this.config.rejoinResumeCountdownMillis;
            this.broadcastAll(state, `:${this.serverName} ${Code.RPL_GAME_RESUME_COUNTDOWN} ${client.nick} :${client.nick},${this.config.rejoinResumeCountdownMillis}`);
            this.schedulePauseTimer(state, client.instance.gameId, this.config.rejoinResumeCountdownMillis);
        }
    }

    private handlePause(client: GservClient): void {
        const state = client.instance ? this.instanceStates.get(client.instance.gameId) : undefined;
        if (!state || !client.instance) {
            return;
        }
        const now = Date.now();
        if (state.paused || state.pauseCountdownUntil !== undefined) {
            return;
        }
        const lastPause = state.lastPauseByNick.get(client.nick) ?? 0;
        if (now - lastPause < this.config.pauseCooldownMillis) {
            this.log.warn(`pause request from ${client.nick} ignored (cooldown)`);
            return;
        }
        state.lastPauseByNick.set(client.nick, now);
        if (state.resumeCountdownUntil !== undefined) {
            this.clearPauseTimer(state);
            state.resumeCountdownUntil = undefined;
            this.broadcastAll(state, `:${this.serverName} ${Code.RPL_GAME_PAUSED} ${client.nick} :${client.nick}`);
            return;
        }
        state.pauseCountdownUntil = now + this.config.pauseCountdownMillis;
        this.log.info(`pause requested by ${client.nick} for instance ${client.instance.gameId}`);
        this.broadcastAll(state, `:${this.serverName} ${Code.RPL_GAME_PAUSE_COUNTDOWN} ${client.nick} :${client.nick},${this.config.pauseCountdownMillis}`);
        this.schedulePauseTimer(state, client.instance.gameId, this.config.pauseCountdownMillis);
    }

    private handleResume(client: GservClient): void {
        const state = client.instance ? this.instanceStates.get(client.instance.gameId) : undefined;
        if (!state || !client.instance) {
            return;
        }
        if (state.pauseCountdownUntil !== undefined) {
            // Cancel a pending pause countdown: the game keeps running.
            this.clearPauseTimer(state);
            state.pauseCountdownUntil = undefined;
            this.log.info(`pause countdown cancelled by ${client.nick} for instance ${client.instance.gameId}`);
            this.broadcastAll(state, `:${this.serverName} ${Code.RPL_GAME_RESUMED} ${client.nick} :${client.nick}`);
            return;
        }
        if (!state.paused || state.resumeCountdownUntil !== undefined) {
            return;
        }
        state.resumeCountdownUntil = Date.now() + this.config.pauseCountdownMillis;
        this.log.info(`resume requested by ${client.nick} for instance ${client.instance.gameId}`);
        this.broadcastAll(state, `:${this.serverName} ${Code.RPL_GAME_RESUME_COUNTDOWN} ${client.nick} :${client.nick},${this.config.pauseCountdownMillis}`);
        this.schedulePauseTimer(state, client.instance.gameId, this.config.pauseCountdownMillis);
    }

    private schedulePauseTimer(state: InstanceState, gameId: string, delayMs: number): void {
        this.clearPauseTimer(state);
        state.pauseTimer = setTimeout(() => {
            state.pauseTimer = undefined;
            const fresh = this.instanceStates.get(gameId);
            if (fresh !== state) {
                return;
            }
            if (state.pauseCountdownUntil !== undefined) {
                state.pauseCountdownUntil = undefined;
                state.paused = true;
                state.pausedAt = Date.now();
                this.log.info(`instance ${gameId} paused`);
                this.broadcastAll(state, `:${this.serverName} ${Code.RPL_GAME_PAUSED} ${gameId} :paused`);
            }
            else if (state.resumeCountdownUntil !== undefined) {
                state.resumeCountdownUntil = undefined;
                state.paused = false;
                if (state.pausedAt !== undefined) {
                    // A departed player's rejoin grace window must not run out
                    // just because everyone else sat on a manual pause: push
                    // every pending deadline out by however long the game was
                    // actually paused.
                    const elapsed = Date.now() - state.pausedAt;
                    for (const [nick, expiry] of state.departedAt) {
                        state.departedAt.set(nick, expiry + elapsed);
                    }
                    state.pausedAt = undefined;
                }
                this.log.info(`instance ${gameId} resumed`);
                // Diagnostic: the deadlock this is chasing always presents as
                // "resumed" logged, then 0 ticks/frames forever. This shows
                // exactly what's sitting unflushed at that moment -- which
                // turn(s) are stuck and which nick(s) are missing from them.
                if (state.pending.size > 0) {
                    const pendingSummary = [...state.pending.entries()]
                        .sort(([a], [b]) => a - b)
                        .map(([turnNo, submissions]) => `${turnNo}:[${[...submissions.keys()].join(",")}]`)
                        .join(" ");
                    this.log.info(`instance ${gameId} pending at resume (lastTurnNo=${state.lastTurnNo}, requiredNicks=${[...state.requiredNicks].join(",")}): ${pendingSummary}`);
                }
                this.flushPendingTurns(state);
                this.broadcastAll(state, `:${this.serverName} ${Code.RPL_GAME_RESUMED} ${gameId} :resumed`);
            }
        }, delayMs);
    }

    private clearPauseTimer(state: InstanceState): void {
        if (state.pauseTimer !== undefined) {
            clearTimeout(state.pauseTimer);
            state.pauseTimer = undefined;
        }
    }

    // Called after a disconnect. If that was the last connected human (bots
    // have no socket, so they never appear in `members`), every pending
    // rejoin deadline is extended to the longer, configurable
    // abandonedInstanceTimeoutSeconds instead of the shorter per-player
    // reconnectGraceSeconds that was used when they dropped — nobody is left
    // to be inconvenienced by a longer hold, and a short config elsewhere
    // shouldn't cut an unattended bot match off before anyone even has a
    // chance to come back. The instance is also marked paused; a returning
    // player's normal rejoin (handleReady) naturally un-pauses it.
    private extendAbandonedInstanceDeadlines(state: InstanceState, gameId: string): void {
        if (state.members.size > 0 || state.departedAt.size === 0) {
            return;
        }
        if (!state.paused) {
            state.paused = true;
            this.log.info(`instance ${gameId} paused: no human players remain`);
        }
        const timeoutSeconds = this.config.abandonedInstanceTimeoutSeconds;
        const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : ABANDONED_HOLD_INDEFINITELY_DEADLINE;
        for (const nick of state.departedAt.keys()) {
            state.departedAt.set(nick, deadline);
        }
    }

    // Resigns a departed player for real: their assets are destroyed and they
    // are marked defeated, exactly like a voluntary leave. Injects the synthetic
    // resign into the next pending turn, drops them from the relay requirement
    // so the game can continue, and permanently blocks a later rejoin.
    //
    // Extracted so the two paths that end a departure -- the grace window
    // running out (expireDeparted) and a kick vote passing early
    // (resignDepartedPlayerEarly) -- share one implementation rather than two
    // copies that could drift apart. Callers are responsible for clearing
    // departedAt/rejoiningNicks and for calling flushPendingTurns afterwards.
    private resignDeparted(state: InstanceState, gameId: string, nick: string, reason: string): void {
        // A resigned player must not be able to reconnect with the same ticket
        // and keep playing a match they were already resigned out of --
        // handleRejoin only ever checked leftNicks, so this has to be set here
        // too (found via manual multiplayer testing).
        state.leftNicks.add(nick);
        const playerId = state.recorder.playerIdFor(nick);
        if (playerId !== undefined) {
            let resignInjected = false;
            for (const submissions of state.pending.values()) {
                if (!submissions.has(nick)) {
                    // The first pending turn resigns the departed player
                    // (their assets are destroyed and they are defeated);
                    // any further pending turns treat them as NoAction.
                    submissions.set(nick, {
                        playerId,
                        blob: resignInjected ? NO_ACTION_BLOB : RESIGN_ACTION_BLOB,
                    });
                    resignInjected = true;
                }
            }
        }
        state.requiredNicks.delete(nick);
        this.log.info(`${reason} for ${nick} in instance ${gameId}; resigning them`);
        this.broadcastAll(state, `:${this.serverName} ${Code.RPL_PLAYER_GAVE_UP} ${nick} :${nick}`);
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
            this.closeVoteSession(state, nick);
            // Only matters if voteOpenDelayMillis is configured larger than
            // the grace window, so the vote never got a chance to open before
            // the timeout beat it to resigning the player -- the timer's own
            // staleness guard (departedAt no longer has the nick) would
            // already no-op it harmlessly, this just avoids leaving a dangling
            // Node timer sitting around until then.
            this.cancelPendingVoteOpen(state, nick);
            expired = true;
            this.resignDeparted(state, gameId, nick, "rejoin grace expired");
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

    // Every broadcastAll/broadcastLine call site in this file omits the
    // trailing "\r\n" (unlike every direct client.socket.send() call, which
    // includes it) — the client's IrcConnection buffers a message with no
    // terminator and silently prepends it onto the *next* incoming message
    // instead of dispatching it, fusing two unrelated lines into one
    // (observed: a chat message glued onto a PONG reply). Terminating here,
    // once, fixes every caller instead of patching each one individually.
    private broadcastAll(state: InstanceState, line: string): void {
        const frame = line + "\r\n";
        for (const member of state.members.values()) {
            member.socket.send(frame);
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
        const state = this.instanceStates.get(instance.gameId);
        const lines: string[] = [];
        for (const nick of instance.players) {
            const member = members?.get(nick);
            // Mirrors the client's PlayerConnectionStatus enum
            // (src/network/gamestate/PlayerConnectionStatus.ts): 0=NotConnected,
            // 1=Connected, 4=Rejoining. Hardcoded rather than imported because
            // server/src and src are separate codebases -- same convention as
            // RESIGN_GAME_ACTION_ID above. A rejoiner is reported distinctly so
            // waiting players can be shown catch-up progress instead of a
            // reconnect countdown, since `loaded` below is the live replay
            // percentage for exactly that window.
            const status = !member ? 0 : state?.rejoiningNicks.has(nick) ? 4 : 1;
            const loaded = member?.loaded ?? 0;
            const timeoutAt = state?.departedAt.get(nick) ?? 0;
            lines.push(`${nick},${status},${loaded},0,0,${timeoutAt}`);
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
        if (data[1] === Code.REQ_BIN_GAME_STATE_HASH && data.length >= 10 && client.instance) {
            const state = this.instanceStates.get(client.instance.gameId);
            if (state) {
                this.handleGameStateHash(state, client.instance.gameId, client, data);
            }
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
            // Diagnostic: promoted from debug -- this is the one signal that
            // distinguishes "the relay is correctly holding for an active
            // rejoin" from "a rejoin's client never cleared this flag", the
            // difference between a normal hold and a permanent deadlock.
            this.log.info(`ignoring actions from ${client.nick}: still rejoining (turn ${new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2, true)})`);
            return;
        }
        const playerId = state.recorder.playerIdFor(client.nick);
        if (playerId === undefined) {
            this.log.warn(`ignoring actions from ${client.nick}: no player slot in gameopts`);
            return;
        }
        const turnNo = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2, true);
        if (turnNo <= state.lastTurnNo) {
            // A client submitting a turn already relayed is normal lockstep
            // behavior (a lagging client catching up), so don't spam the log.
            const now = Date.now();
            if ((state.lastStaleLogByNick.get(client.nick) ?? 0) + STALE_TURN_LOG_INTERVAL_MS < now) {
                state.lastStaleLogByNick.set(client.nick, now);
                // Diagnostic: promoted from debug -- a rejoiner's first live
                // submission landing here (turnNo <= lastTurnNo right after a
                // resume) would mean its resync point disagreed with the
                // relay's, which silently drops every submission after it too.
                this.log.info(`ignoring stale turn ${turnNo} from ${client.nick} (relay at ${state.lastTurnNo})`);
            }
            return;
        }
        if (turnNo > state.lastTurnNo + TURN_WINDOW) {
            this.log.warn(`ignoring out-of-window turn ${turnNo} from ${client.nick} (relay at ${state.lastTurnNo}, window ${TURN_WINDOW})`);
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

    private handleGameStateHash(state: InstanceState, gameId: string, client: GservClient, data: Uint8Array): void {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const turnNo = view.getUint32(2, true);
        const hash = view.getUint32(6, true);
        let hashes = state.hashByTurn.get(turnNo);
        if (!hashes) {
            hashes = new Map();
            state.hashByTurn.set(turnNo, hashes);
        }
        hashes.set(client.nick, hash);
        // Full hash trail, not just the mismatch line, so a repro's server
        // log alone can show exactly which turn a peer's hash first
        // disagrees with another's, even before both are in.
        this.log.info(`hash check: instance ${gameId} turn ${turnNo} ${client.nick}=${hash}`);
        if (hashes.size >= 2) {
            const values = [...hashes.values()];
            const first = values[0];
            if (!state.desyncReported && values.some(value => value !== first)) {
                state.desyncReported = true;
                this.log.error(`DESYNC detected in instance ${gameId} at turn ${turnNo}: ` +
                    [...hashes.entries()].map(([nick, h]) => `${nick}=${h}`).join(" "));
                for (const member of state.members.values()) {
                    member.socket.send(`:${this.serverName} ${Code.RPL_GAME_DESYNC} ${member.nick} :desync\r\n`);
                }
            }
            for (const turn of state.hashByTurn.keys()) {
                if (turn < turnNo - 8) {
                    state.hashByTurn.delete(turn);
                }
            }
        }
    }

    private flushPendingTurns(state: InstanceState): void {
        if (state.paused || state.resumeCountdownUntil !== undefined) {
            return;
        }
        // Hold the relay while a non-observer player is still catching up after
        // a re-join: the resync point must stay stable until they signal ready,
        // otherwise their first live submissions would be stale (relayed while
        // they were away) and the relay would wait on a gap turn forever.
        for (const nick of state.rejoiningNicks) {
            if (state.recorder.playerIdFor(nick) !== undefined && !state.recorder.isObserver(nick)) {
                return;
            }
        }
        this.backfillRejoinedNicks(state);
        // Strictly in order: a turn's actions are only ever usable once every
        // earlier turn has already been relayed (LockstepManager looks two
        // turns back), so broadcasting a later-ready turn out of order would
        // permanently strand whatever gap is still sitting behind it -- no
        // client would ever ask for it again, and no one still deadlocked
        // waiting on it would ever get unstuck.
        for (const turnNo of [...state.pending.keys()].sort((a, b) => a - b)) {
            const submissions = state.pending.get(turnNo);
            if (!submissions || ![...state.requiredNicks].every(nick => submissions.has(nick))) {
                break;
            }
            this.broadcastTurn(state, turnNo);
        }
    }

    // A rejoining player's LockstepManager holds off submitting anything
    // live while it's still replaying from turn 0 to catch up -- so any
    // turn another player kept submitting (unconfirmed) to state.pending
    // while this nick was still catching up can never complete on its own.
    // Once we can see the nick's own earliest real
    // submission in state.pending, every still-pending turn strictly before
    // it is provably one the nick will never fill in itself, so it's
    // backfilled with a no-op, the same way handlePassive/handleLeave
    // already backfill a player who stops being required entirely. Turns at
    // or after that point are left untouched -- deliberately never guessed
    // at ahead of time, so a real, still-in-flight submission is never
    // clobbered by a premature no-op.
    private backfillRejoinedNicks(state: InstanceState): void {
        if (state.pendingRejoinBackfill.size === 0) {
            return;
        }
        const turnNumbers = [...state.pending.keys()].sort((a, b) => a - b);
        for (const nick of [...state.pendingRejoinBackfill]) {
            const playerId = state.recorder.playerIdFor(nick);
            if (playerId === undefined) {
                state.pendingRejoinBackfill.delete(nick);
                continue;
            }
            const firstOwnTurn = turnNumbers.find(turnNo => state.pending.get(turnNo)!.has(nick));
            if (firstOwnTurn === undefined) {
                // Nothing from this nick yet -- try again next time
                // flushPendingTurns runs (i.e. the next accepted submission
                // from anyone), rather than guessing.
                continue;
            }
            for (const turnNo of turnNumbers) {
                if (turnNo >= firstOwnTurn) {
                    break;
                }
                const submissions = state.pending.get(turnNo)!;
                if (!submissions.has(nick)) {
                    submissions.set(nick, { playerId, blob: NO_ACTION_BLOB });
                }
            }
            state.pendingRejoinBackfill.delete(nick);
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
        this.clearPauseTimer(state);
        // The timer callback's own staleness guard (instanceStates no longer
        // has this state) would make a leftover pending vote-open harmless,
        // but clear them outright rather than leaving Node timer handles
        // dangling until they fire on their own.
        for (const timer of state.pendingVoteOpens.values()) {
            clearTimeout(timer);
        }
        state.pendingVoteOpens.clear();
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
        this.forEachOtherMember(sender, other => other.socket.send(line + "\r\n"));
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
