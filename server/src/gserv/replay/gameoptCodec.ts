// Server-side implementation of the RA2 lockstep action codec and the subset
// of the gameopts format needed to reconstruct per-player action maps and
// replay tick numbers. Mirrors src/network/gameopt/{Parser,Serializer}.ts and
// src/data/DataStream.ts (little-endian) so server-written replays are
// byte-compatible with the client's Replay/ReplayTurnManager.

export const NO_ACTION_ID = 0;
export const BASE_TICKS_PER_SECOND = 15;
export const OBSERVER_COUNTRY_ID = -3;

export interface ActionData {
    id: number;
    params: Uint8Array;
}

export interface HumanPlayerInfo {
    name: string;
    countryId: number;
    colorId: number;
    startPos: number;
    teamId: number;
}

export interface ParsedGameOpts {
    gameSpeed: number;
    humanPlayers: HumanPlayerInfo[];
}

class DataStream {
    private buffer: ArrayBuffer;
    private view: DataView;
    private offset = 0;
    private length: number;

    constructor(data?: Uint8Array) {
        if (data) {
            this.buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
            this.view = new DataView(this.buffer);
            this.length = data.byteLength;
        }
        else {
            this.buffer = new ArrayBuffer(32);
            this.view = new DataView(this.buffer);
            this.length = 0;
        }
    }

    get byteLength(): number {
        return this.length;
    }

    private ensure(bytes: number): void {
        const needed = this.offset + bytes;
        if (needed <= this.buffer.byteLength) {
            if (needed > this.length) {
                this.length = needed;
            }
            return;
        }
        let capacity = this.buffer.byteLength * 2;
        while (capacity < needed) {
            capacity *= 2;
        }
        const next = new ArrayBuffer(capacity);
        new Uint8Array(next, 0, this.length).set(new Uint8Array(this.buffer, 0, this.length));
        this.buffer = next;
        this.view = new DataView(next);
        this.length = needed;
    }

    writeUint8(value: number): void {
        this.ensure(1);
        this.view.setUint8(this.offset, value);
        this.offset += 1;
    }

    writeUint16(value: number): void {
        this.ensure(2);
        this.view.setUint16(this.offset, value, true);
        this.offset += 2;
    }

    writeUint32(value: number): void {
        this.ensure(4);
        this.view.setUint32(this.offset, value, true);
        this.offset += 4;
    }

    writeBytes(bytes: Uint8Array): void {
        this.ensure(bytes.length);
        new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
        this.offset += bytes.length;
    }

    readUint8(): number {
        const value = this.view.getUint8(this.offset);
        this.offset += 1;
        return value;
    }

    readUint16(): number {
        const value = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return value;
    }

    readUint32(): number {
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    readBytes(count: number): Uint8Array {
        const value = new Uint8Array(this.buffer, this.offset, count).slice();
        this.offset += count;
        return value;
    }

    toUint8Array(): Uint8Array {
        return new Uint8Array(this.buffer, 0, this.length);
    }
}

export function serializePlayerActions(actions: ActionData[]): Uint8Array {
    const stream = new DataStream();
    stream.writeUint8(actions.length);
    for (const { id, params } of actions) {
        stream.writeUint8(id);
        stream.writeUint16(params.byteLength);
        if (params.byteLength > 0) {
            stream.writeBytes(params);
        }
    }
    return stream.toUint8Array();
}

export function parsePlayerActions(data: Uint8Array): ActionData[] {
    const stream = new DataStream(data);
    const actionCount = stream.readUint8();
    const actions: ActionData[] = [];
    for (let i = 0; i < actionCount; i++) {
        const id = stream.readUint8();
        const paramLength = stream.readUint16();
        const params = paramLength > 0 ? stream.readBytes(paramLength) : new Uint8Array();
        actions.push({ id, params });
    }
    return actions;
}

export function serializeAllPlayerActions(allActions: Map<number, ActionData[]>): Uint8Array {
    const stream = new DataStream();
    stream.writeUint8(allActions.size);
    for (const [playerId, actions] of allActions) {
        stream.writeUint8(playerId);
        const serialized = serializePlayerActions(actions);
        stream.writeUint16(serialized.byteLength);
        if (serialized.byteLength > 0) {
            stream.writeBytes(serialized);
        }
    }
    return stream.toUint8Array();
}

export function parseAllPlayerActions(data: Uint8Array): Map<number, ActionData[]> {
    const stream = new DataStream(data);
    const playerCount = stream.readUint8();
    const allActions = new Map<number, ActionData[]>();
    for (let i = 0; i < playerCount; i++) {
        const playerId = stream.readUint8();
        const dataLength = stream.readUint16();
        const blob = dataLength > 0 ? stream.readBytes(dataLength) : new Uint8Array();
        allActions.set(playerId, parsePlayerActions(blob));
    }
    return allActions;
}

// The serialized gameopts string the host sends via the gameopt command:
// "<optionsPart>:<playersPart>:@:<aiPart>," where optionsPart is comma-joined
// with the 3rd field (index 2) being "6 - gameSpeed".
export function parseGameOpts(opts: string): ParsedGameOpts {
    const [gameOptsPart, playersPart] = opts.split(":");
    const parts = gameOptsPart.split(",");
    const gameSpeed = 6 - Number(parts[2]);
    const humanPlayers: HumanPlayerInfo[] = [];
    if (playersPart) {
        const playerParts = playersPart.split(",");
        for (let i = 0; i + 7 < playerParts.length; i += 8) {
            humanPlayers.push({
                name: playerParts[i],
                countryId: Number(playerParts[i + 1]),
                colorId: Number(playerParts[i + 2]),
                startPos: Number(playerParts[i + 3]),
                teamId: Number(playerParts[i + 4]),
            });
        }
    }
    return { gameSpeed, humanPlayers };
}

export function isObserverPlayer(player: HumanPlayerInfo): boolean {
    return player.countryId === OBSERVER_COUNTRY_ID;
}

export function computeTicksPerSecond(gameSpeed: number): number {
    if (gameSpeed === 6) {
        return 60;
    }
    if (gameSpeed === 5) {
        return 45;
    }
    return 60 / (6 - gameSpeed);
}

export function computeGameTurnMillis(gameSpeed: number): number {
    return 1000 / computeTicksPerSecond(gameSpeed);
}

export function computeNetworkTurnMillis(rateMillis: number, gameTurnMillis: number): number {
    return Math.max(1, Math.ceil(rateMillis / gameTurnMillis)) * gameTurnMillis;
}

export function hasActualActions(actions: ActionData[]): boolean {
    return actions.some(action => action.id !== NO_ACTION_ID);
}
