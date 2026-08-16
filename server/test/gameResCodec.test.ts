import { describe, expect, test } from "bun:test";
import { decodeGameRes, GameResDecodeError, GameResType } from "../src/ladder/gameResCodec";

// Mirrors src/network/gameres/GameRes.ts writeType/toBinary on the client so
// the fixture is byte-identical to what the client actually produces.
const FIELD_BYTE = 1;
const FIELD_BOOLEAN = 2;
const FIELD_TIME = 5;
const FIELD_INT = 6;
const FIELD_STRING = 7;

interface Field {
    name: string;
    type: number;
    value: number | boolean | string;
}

function pushField(target: number[], name: string, type: number, value: number | boolean | string): void {
    const nameBytes = [...Buffer.from(name, "ascii"), 0, 0, 0, 0].slice(0, 4);
    target.push(...nameBytes);
    const typeBytes = Buffer.alloc(2);
    typeBytes.writeUInt16BE(type);
    target.push(...typeBytes);
    if (type === FIELD_BOOLEAN) {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(1);
        target.push(...length, value ? 1 : 0, 0, 0, 0);
        return;
    }
    if (type === FIELD_STRING) {
        const text = String(value);
        const lengthBytes = Buffer.alloc(2);
        lengthBytes.writeUInt16BE(text.length + 1);
        target.push(...lengthBytes);
        const padded = Buffer.alloc(4 * Math.ceil((text.length + 1) / 4));
        Buffer.from(text, "utf8").copy(padded);
        target.push(...padded);
        return;
    }
    const lengthBytes = Buffer.alloc(2);
    lengthBytes.writeUInt16BE(4);
    const valueBytes = Buffer.alloc(4);
    valueBytes.writeUInt32BE(Number(value));
    target.push(...lengthBytes, ...valueBytes);
}

function buildPacket(fields: Field[]): Uint8Array {
    const body: number[] = [];
    for (const field of fields) {
        pushField(body, field.name, field.type, field.value);
    }
    const header = Buffer.alloc(4);
    header.writeUInt16BE(body.length + 4, 0);
    header.writeUInt16BE(0, 2);
    return new Uint8Array([...header, ...body]);
}

function str(name: string, value: string): Field {
    return { name, type: FIELD_STRING, value };
}

function int(name: string, value: number): Field {
    return { name, type: FIELD_INT, value };
}

function bool(name: string, value: boolean): Field {
    return { name, type: FIELD_BOOLEAN, value };
}

const GMID = "g1-m8t7p4x2";

// A finished, tournament 1v1: alice won, bob lost.
function buildValidReport(overrides: Record<string, number | boolean | string> = {}): Uint8Array {
    const merged = { finished: true, oosy: false, shrt: false, trny: true, dura: 300, gsku: 16640, cmp0: GameResType.Win, cmp1: GameResType.Loss, ...overrides };
    return buildPacket([
        int("PLRS", 2),
        int("AIPL", 0),
        bool("CRAT", false),
        int("DURA", merged.dura as number),
        bool("FINI", merged.finished as boolean),
        int("GSKU", merged.gsku as number),
        int("CRED", 10000),
        bool("OOSY", merged.oosy as boolean),
        str("SCEN", "Island War"),
        bool("SHRT", merged.shrt as boolean),
        int("SPED", 6),
        bool("SUPR", true),
        int("TIME", 1723000000),
        bool("TRNY", merged.trny as boolean),
        int("UNIT", 50),
        str("VERS", "0.83.2"),
        int("MODE", 1),
        int("BAMR", 0),
        str("MAPC", "mapdigest"),
        str("GMID", GMID),
        str("SNAM", "alice"),
        str("NAM0", "alice"),
        int("CMP0", merged.cmp0 as number),
        int("COL0", 0),
        str("NAM1", "bob"),
        int("CMP1", merged.cmp1 as number),
        int("COL1", 1),
    ]);
}

describe("gameResCodec", () => {
    test("decodes a finished tournament 1v1 report", () => {
        const report = decodeGameRes(buildValidReport());
        expect(report.gameId).toBe(GMID);
        expect(report.sku).toBe(16640);
        expect(report.finished).toBe(true);
        expect(report.outOfSync).toBe(false);
        expect(report.shortGame).toBe(false);
        expect(report.tournament).toBe(true);
        expect(report.duration).toBe(300);
        expect(report.accountName).toBe("alice");
        expect(report.players).toEqual([
            { name: "alice", completionStatus: GameResType.Win },
            { name: "bob", completionStatus: GameResType.Loss },
        ]);
    });

    test("round-trips through base64 like the client POSTs it", () => {
        const packet = buildValidReport();
        const encoded = Buffer.from(packet).toString("base64");
        const decoded = decodeGameRes(new Uint8Array(Buffer.from(encoded, "base64")));
        expect(decoded.gameId).toBe(GMID);
    });

    test("reads non-complementary and unfinished states", () => {
        expect(decodeGameRes(buildValidReport({ finished: false })).finished).toBe(false);
        expect(decodeGameRes(buildValidReport({ oosy: true })).outOfSync).toBe(true);
        expect(decodeGameRes(buildValidReport({ shrt: true })).shortGame).toBe(true);
        expect(decodeGameRes(buildValidReport({ trny: false })).tournament).toBe(false);
        expect(decodeGameRes(buildValidReport({ dura: 45 })).duration).toBe(45);
    });

    test("maps every client completion status", () => {
        const statuses = [GameResType.Win, GameResType.Loss, GameResType.Resign, GameResType.Disconnect, GameResType.ConnectionLost, GameResType.Draw, GameResType.Playing];
        for (const status of statuses) {
            const report = decodeGameRes(buildValidReport({ cmp0: status }));
            expect(report.players[0].completionStatus).toBe(status);
        }
    });

    test("rejects packets with a wrong header length", () => {
        const packet = buildValidReport();
        packet[0] += 4;
        expect(() => decodeGameRes(packet)).toThrow(GameResDecodeError);
    });

    test("rejects packets that are too short", () => {
        expect(() => decodeGameRes(new Uint8Array([1, 2]))).toThrow(GameResDecodeError);
    });

    test("rejects packets missing GMID", () => {
        const rebuilt = buildPacket([
            int("PLRS", 2),
            bool("FINI", true),
            int("GSKU", 16640),
            bool("OOSY", false),
            bool("SHRT", false),
            bool("TRNY", true),
            int("DURA", 300),
            str("GMID", ""),
            str("SNAM", "alice"),
            str("NAM0", "alice"),
            int("CMP0", GameResType.Win),
            str("NAM1", "bob"),
            int("CMP1", GameResType.Loss),
        ]);
        expect(() => decodeGameRes(rebuilt)).toThrow(GameResDecodeError);
    });

    test("4-char field names are preserved exactly", () => {
        const report = decodeGameRes(buildValidReport());
        expect(report.duration).toBe(300);
        expect(report.players[0].name).toBe("alice");
    });
});
