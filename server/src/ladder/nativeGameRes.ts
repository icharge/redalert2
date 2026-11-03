/** Native RA2/YR PacketClass, not the web client's GMID/SNAM report format.
 * Native FieldClass constructors: flag=2/1B, signed=5/4B, unsigned=6/4B,
 * C string=7, blob=20. PacketClass pads every payload to four bytes.
 */
export const NATIVE_RESULT_MAX = 32768;
export type NativeField = number | string | number[];
export interface NativeGameRes {
    gameNumber: number;
    sku: number;
    finished: boolean;
    outOfSync: boolean;
    duration: number;
    mapName: string;
    aiPlayers: number;
    players: { name: string; completionStatus: number }[];
    fields: Record<string, NativeField>;
    /** Sanitized packet; account, IP and unrecognized fields have been removed. */
    packetBase64: string;
}
export interface StoredNativeReport extends NativeGameRes {
    reporter: string;
    source: "native-client";
    digest: string;
    reportedAt: number;
}
export class NativeResultError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
const safeGlobal = new Set("IDNO GSKU TRNY OOSY FINI DURA CRED SHRT SUPR MODE BAMR BASE CRAT AIPL UNIT SCEN PNGS PNGR PLRS TIME AFPS SPED VERS DATE BROK".split(" "));
const safePlayer = /^(NAM|CMP|CID|SID|TID|LCN|COL|CTY|CRD|INB|UNB|PLB|BLB|INL|UNL|PLL|BLL|INK|UNK|PLK|BLK|BLC|CRA|HRV)[0-7]$/;

export function decodeNativeGameRes(bytes: Uint8Array): NativeGameRes {
    const fail = (message: string): never => { throw new NativeResultError(message); };
    if (bytes.length < 4 || bytes.length > NATIVE_RESULT_MAX) fail("invalid packet size");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0) !== bytes.length || view.getUint16(2) !== 0) fail("invalid packet header");
    const fields: Record<string, NativeField> = {};
    const seen = new Set<string>();
    const kept: Buffer[] = [];
    for (let at = 4; at < bytes.length;) {
        if (at + 8 > bytes.length) fail("truncated field header");
        const name = Buffer.from(bytes.subarray(at, at + 4)).toString("latin1");
        if (!/^[A-Z0-9]{4}$/.test(name) || seen.has(name)) fail("invalid or duplicate field");
        seen.add(name);
        const type = view.getUint16(at + 4), length = view.getUint16(at + 6);
        const end = at + 8 + Math.ceil(length / 4) * 4;
        // Type 20 is a byte array; the retail client emits empty arrays for the
        // per-house slots it did not use (CRA1/BLC1/... with length 0). Those
        // are valid records, not truncation.
        if (end > bytes.length || (length === 0 && type !== 20)) fail("truncated field payload");
        const data = bytes.subarray(at + 8, at + 8 + length);
        const payload = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let value: NativeField;
        if (type >= 1 && type <= 6) {
            const width = type <= 2 ? 1 : type <= 4 ? 2 : 4;
            if (length !== width) fail("invalid numeric width");
            value = width === 1 ? (type === 1 ? payload.getInt8(0) : payload.getUint8(0))
                : width === 2 ? (type === 3 ? payload.getInt16(0) : payload.getUint16(0))
                : type === 5 ? payload.getInt32(0) : payload.getUint32(0);
        } else if (type === 7) {
            if (data[data.length - 1] !== 0 || data.subarray(0, -1).includes(0)) fail("invalid string");
            value = Buffer.from(data.subarray(0, -1)).toString("latin1");
        } else if (type === 20) value = Array.from(data);
        else fail("unknown native field type");
        if (safeGlobal.has(name) || safePlayer.test(name)) {
            fields[name] = value!;
            // Recreate padding as zero: the original buffer's padding may be uninitialized.
            const safe = Buffer.alloc(end - at); safe.set(bytes.subarray(at, at + 8 + length)); kept.push(safe);
        }
        at = end;
    }
    const integer = (key: string): number => {
        const n = fields[key];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) fail(`invalid ${key}`);
        return n as number;
    };
    const text = (key: string): string => {
        const s = fields[key];
        if (typeof s !== "string" || s.length > 255 || /[\x00-\x1f\x7f]/.test(s)) fail(`invalid ${key}`);
        return s as string;
    };
    const count = integer("PLRS");
    if (count < 1 || count > 8) fail("invalid player count");
    const players = Array.from({ length: count }, (_, i) => ({ name: text(`NAM${i}`), completionStatus: integer(`CMP${i}`) }));
    if (players.some(p => !p.name || p.name.length > 64) || new Set(players.map(p => p.name.toLowerCase())).size !== count) fail("invalid player names");
    const sku = integer("GSKU"), finished = integer("FINI"), outOfSync = integer("OOSY");
    // 8960 (0x2300) is what the retail Red Alert 2 native client reports in
    // GSKU; 16640/18688 are the Yuri's Revenge-era values the ladder used.
    if (![8960, 16640, 18688].includes(sku) || finished > 1 || outOfSync > 1) fail("invalid edition or flags");
    const clean = Buffer.concat([Buffer.alloc(4), ...kept]); clean.writeUInt16BE(clean.length);
    return { gameNumber: integer("IDNO"), sku, finished: !!finished, outOfSync: !!outOfSync,
        duration: integer("DURA"), mapName: text("SCEN"), aiPlayers: integer("AIPL"), players, fields,
        packetBase64: clean.toString("base64") };
}

export function nativeResultType(status: number): number {
    if (status === 256) return 0;
    if ([512, 528, 768].includes(status)) return 1;
    if (status === 64) return 2;
    return -1;
}
