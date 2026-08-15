import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Logger } from "../../logger";
import { GservInstance } from "../GservManager";
import {
    ActionData,
    ParsedGameOpts,
    computeGameTurnMillis,
    computeNetworkTurnMillis,
    hasActualActions,
    isObserverPlayer,
    parseGameOpts,
    parsePlayerActions,
    serializeAllPlayerActions,
} from "./gameoptCodec";

const REPLAY_VERSION = 6;
const MAX_NAME_LENGTH = 128;

enum ReplayEventType {
    TurnActions = 0,
    ChatMessage = 1,
    Taunt = 2,
}

interface ReplayEvent {
    tickNo: number;
    type: ReplayEventType;
    payload: string;
}

export interface ReplayRecorderOptions {
    gameVersion: string;
    modHash?: string;
    netRateMs: number;
    replaysDir: string;
    enabled: boolean;
    log: Logger;
}

function sanitizeFileName(filename: string): string {
    return filename
        .replace(/[/?<>\\:*|"]/g, "_")
        .replace(/[\x00-\x1f\x7f\x80-\x9f]/g, "_")
        .slice(0, MAX_NAME_LENGTH);
}

function base64EncodeBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

function base64EncodeUtf16(str: string): string {
    const bytes = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        bytes[i * 2] = (code >> 8) & 0xff;
        bytes[i * 2 + 1] = code & 0xff;
    }
    return base64EncodeBytes(bytes);
}

export class GservReplayRecorder {
    private readonly nickToPlayerId = new Map<string, number>();
    private readonly observerNicks = new Set<string>();
    private readonly subturnsPerTurn: number;
    private readonly events: ReplayEvent[] = [];
    private lastTurnNo = -1;

    constructor(
        private readonly instance: GservInstance,
        private readonly options: ReplayRecorderOptions,
    ) {
        const opts: ParsedGameOpts = parseGameOpts(instance.gameopts ?? "");
        const gameTurnMillis = computeGameTurnMillis(opts.gameSpeed);
        const networkTurnMillis = computeNetworkTurnMillis(options.netRateMs, gameTurnMillis);
        this.subturnsPerTurn = networkTurnMillis / gameTurnMillis;
        opts.humanPlayers.forEach((player, index) => {
            this.nickToPlayerId.set(player.name, index);
            if (isObserverPlayer(player)) {
                this.observerNicks.add(player.name);
            }
        });
    }

    isObserver(nick: string): boolean {
        return this.observerNicks.has(nick);
    }

    playerIdFor(nick: string): number | undefined {
        return this.nickToPlayerId.get(nick);
    }

    // Game tick at which a given network turn's actions are applied by clients:
    // turn N's actions are processed at the start of network turn N+2, i.e. after
    // (N+2) * subturnsPerTurn game updates. Mirrors LockstepManager.doGameTurn.
    tickForTurn(turnNo: number): number {
        return (turnNo + 2) * this.subturnsPerTurn;
    }

    recordTurn(turnNo: number, playerBlobs: Map<number, Uint8Array>): void {
        this.lastTurnNo = Math.max(this.lastTurnNo, turnNo);
        if (!this.options.enabled) {
            return;
        }
        const allActions = new Map<number, ActionData[]>();
        for (const [playerId, blob] of playerBlobs) {
            allActions.set(playerId, parsePlayerActions(blob));
        }
        if ([...allActions.values()].some(hasActualActions)) {
            const payload = base64EncodeBytes(serializeAllPlayerActions(allActions));
            this.events.push({ tickNo: this.tickForTurn(turnNo), type: ReplayEventType.TurnActions, payload });
        }
    }

    recordChat(nick: string, message: string): void {
        if (!this.options.enabled) {
            return;
        }
        const playerId = this.nickToPlayerId.get(nick);
        if (playerId === undefined) {
            return;
        }
        this.events.push({
            tickNo: this.currentTick(),
            type: ReplayEventType.ChatMessage,
            payload: playerId + ":" + base64EncodeUtf16(message),
        });
    }

    recordTaunt(nick: string, tauntNo: number): void {
        if (!this.options.enabled) {
            return;
        }
        const playerId = this.nickToPlayerId.get(nick);
        if (playerId === undefined) {
            return;
        }
        this.events.push({
            tickNo: this.currentTick(),
            type: ReplayEventType.Taunt,
            payload: playerId + ":" + tauntNo,
        });
    }

    get hasCapturedTurns(): boolean {
        return this.lastTurnNo >= 0;
    }

    get hasEvents(): boolean {
        return this.events.length > 0;
    }

    private currentTick(): number {
        return this.lastTurnNo >= 0 ? this.tickForTurn(this.lastTurnNo) : 0;
    }

    finalize(): string {
        if (!this.options.enabled) {
            throw new Error("Replay recorder is disabled");
        }
        this.events.sort((a, b) => a.tickNo - b.tickNo || a.type - b.type);
        const engineVersion = this.options.gameVersion.split(".").slice(0, 2).join(".");
        const modHash = this.options.modHash ?? "0";
        const lines: string[] = [
            "RA2TSREPL_v" + REPLAY_VERSION,
            `ENGINE ${engineVersion} ${modHash}`,
            [this.instance.gameId, this.instance.timestamp, this.instance.gameopts ?? ""].join(" "),
        ];
        for (const event of this.events) {
            lines.push(`${event.tickNo}=${event.type}|${event.payload}`);
        }
        lines.push("END " + this.currentTick());
        const dir = this.options.replaysDir;
        mkdirSync(dir, { recursive: true });
        const name = sanitizeFileName(
            `game-${this.instance.gameId} ${new Date().toISOString().replace(/(\.|,)\d+Z$/, "Z")}`,
        ) + ".rpl";
        const filePath = path.join(dir, name);
        writeFileSync(filePath, lines.join("\n") + "\n");
        return filePath;
    }
}
