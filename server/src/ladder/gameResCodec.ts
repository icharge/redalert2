// Server-side decoder for the client's GameRes.toBinary() packet
// (src/network/gameres/GameRes.ts). The client posts this packet base64-encoded
// to /wgameres/{sku}; we only need the fields that decide whether a ranked
// match counts and which side won, plus the roster names.
//
// Wire format (all big-endian, mirrors GameRes.writeType/readType):
//   u16  total packet length including this 4-byte header
//   u16  0
//   repeated:
//     string(4)  field name, e.g. "GMID", "NAM0", "CMP1"
//     u16        field type: 1=Byte 2=Boolean 5=Time 6=Int 7=String
//     u16        payload length
//     payload    u32 (Byte/Time/Int), 4 bytes with first byte set (Boolean),
//                NUL-terminated string padded to 4 (String)

import { DataStream } from "../gserv/replay/gameoptCodec";

export const GAME_RES_FIELD_BYTE = 1;
export const GAME_RES_FIELD_BOOLEAN = 2;
export const GAME_RES_FIELD_TIME = 5;
export const GAME_RES_FIELD_INT = 6;
export const GAME_RES_FIELD_STRING = 7;

// Completion status enum values from src/network/gameres/GameResType.ts.
export enum GameResType {
    ConnectionLost = 2,
    Playing = 8,
    Draw = 64,
    Win = 256,
    Loss = 512,
    Resign = 528,
    Disconnect = 768,
}

export interface GameResPlayerInfo {
    name: string;
    completionStatus: GameResType;
}

export interface DecodedGameRes {
    gameId: string;
    sku: number;
    finished: boolean;
    outOfSync: boolean;
    shortGame: boolean;
    tournament: boolean;
    duration: number;
    version: string;
    accountName: string;
    players: GameResPlayerInfo[];
}

export class GameResDecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GameResDecodeError";
    }
}

export function decodeGameRes(data: Uint8Array): DecodedGameRes {
    if (data.length < 4) {
        throw new GameResDecodeError("packet too short");
    }
    const stream = new DataStream(data);
    const totalLength = stream.readUint16BE();
    if (totalLength !== data.length) {
        throw new GameResDecodeError(`length mismatch: header says ${totalLength}, got ${data.length}`);
    }
    if (stream.readUint16BE() !== 0) {
        throw new GameResDecodeError("second header byte should be 0");
    }

    const flat = new Map<string, unknown>();
    const bodyLength = totalLength - 4;
    while (bodyLength > 0 && stream.position <= bodyLength - 4) {
        const { fieldName, type, value } = readField(stream);
        if (value !== undefined) {
            flat.set(fieldName, value);
        }
    }

    const toString = (name: string): string => {
        const value = flat.get(name);
        return typeof value === "string" ? value : "";
    };
    const toInt = (name: string): number => {
        const value = flat.get(name);
        return typeof value === "number" ? value : 0;
    };
    const toBool = (name: string): boolean => flat.get(name) === true;

    const playerCount = toInt("PLRS");
    const players: GameResPlayerInfo[] = [];
    for (let index = 0; index < playerCount; index++) {
        const name = toString("NAM" + index);
        if (!name) {
            throw new GameResDecodeError(`missing NAM${index} for player ${index}`);
        }
        players.push({
            name,
            completionStatus: toInt("CMP" + index) as GameResType,
        });
    }

    const gameId = toString("GMID");
    if (!gameId) {
        throw new GameResDecodeError("missing GMID");
    }
    return {
        gameId,
        sku: toInt("GSKU"),
        finished: toBool("FINI"),
        outOfSync: toBool("OOSY"),
        shortGame: toBool("SHRT"),
        tournament: toBool("TRNY"),
        duration: toInt("DURA"),
        version: toString("VERS"),
        accountName: toString("SNAM"),
        players,
    };
}

function readField(stream: DataStream): { fieldName: string; type: number; value: unknown } {
    const fieldName = Buffer.from(stream.readBytes(4)).toString("latin1").replace(/\0+$/, "");
    const type = stream.readUint16BE();
    const length = stream.readUint16BE();
    let value: unknown;
    switch (type) {
        case GAME_RES_FIELD_BYTE:
        case GAME_RES_FIELD_TIME:
        case GAME_RES_FIELD_INT:
            value = stream.readUint32BE();
            break;
        case GAME_RES_FIELD_BOOLEAN:
            value = stream.readBytes(4)[0] !== 0;
            break;
        case GAME_RES_FIELD_STRING:
            value = stream.readCString(4 * Math.ceil(length / 4));
            break;
        default:
            stream.readBytes(length);
            value = undefined;
    }
    return { fieldName, type, value };
}
