// World Domination Tour: the tagged container the game client parses.
//
// Layout (little-endian host values, big-endian lengths on the wire):
//
//   u16 BE  total length, including this 4-byte header
//   u16 BE  kind (0)
//   record*:  char tag[4]
//             u16 BE field (reserved; the client ignores it)
//             u16 BE value length
//             value bytes, padded to a four-byte boundary
//
// The client's WDTState constructor (YR 0x76AC90, RA2 0x72BFA0) walks exactly
// this shape. Integers inside a value are little-endian: the reader copies the
// four bytes straight into a host uint32.
//
// Tags the constructor reads:
//   NACK  string   the server refused the request
//   TOTK  uint32   previous cycle: factions - 1
//   CRTK  uint32   current cycle:  factions - 1
//   CYLN  uint32   cycle length in days - 1
//   WURL  string   info URL
//   SDSC  string   short description
//   LDSC  string   long description
//   MPVC  bytes    current cycle only: 44-byte territory records
//   HSVC  bytes    owner map, two bits per (row, territory), low bits first
//   CMID  uint8    map/continent id
//   CYID  uint32   cycle id
//   TICC  uint32   territories per continent (30)
//
// A previous-cycle packet replaces CRTK/MPVC/TICC with TOTK; the client then
// derives rows from TOTK and the width is always 30.

import type { WdtState } from "./types";

export const TERRITORIES_PER_CONTINENT = 30;
export const TERRITORY_RECORD_BYTES = 44;

export interface WdtRecord {
    tag: string;
    value: Buffer;
}

export class WdtCodecError extends Error {
    constructor(message: string, readonly offset: number) {
        super(message);
        this.name = "WdtCodecError";
    }
}

const TAG_BYTES = 4;
const RECORD_HEADER = 8;
const CONTAINER_HEADER = 4;

function be16(value: number): Buffer {
    const out = Buffer.allocUnsafe(2);
    out.writeUInt16BE(value & 0xffff, 0);
    return out;
}

export function le32(value: number): Buffer {
    const out = Buffer.allocUnsafe(4);
    out.writeUInt32LE(value >>> 0, 0);
    return out;
}

export function encodeContainer(records: WdtRecord[], kind = 0): Buffer {
    const parts: Buffer[] = [];
    let total = CONTAINER_HEADER;
    for (const record of records) {
        if (record.tag.length !== TAG_BYTES) throw new WdtCodecError(`tag must be four bytes: ${record.tag}`, 0);
        const padded = (record.value.length + 3) & ~3;
        const header = Buffer.allocUnsafe(RECORD_HEADER);
        header.write(record.tag, 0, "ascii");
        header.writeUInt16BE(0, 4);
        header.writeUInt16BE(record.value.length, 6);
        parts.push(header, record.value);
        if (padded > record.value.length) parts.push(Buffer.alloc(padded - record.value.length));
        total += RECORD_HEADER + padded;
    }
    if (total > 0xffff) throw new WdtCodecError("WDT container exceeds 65535 bytes", 0);
    return Buffer.concat([be16(total), be16(kind), ...parts]);
}

export function decodeContainer(packet: Buffer): Map<string, Buffer> {
    if (packet.length < CONTAINER_HEADER) throw new WdtCodecError("truncated header", 0);
    const total = packet.readUInt16BE(0);
    if (total < CONTAINER_HEADER || total > packet.length) {
        throw new WdtCodecError(`bad container length ${total} for ${packet.length} bytes`, 0);
    }
    const records = new Map<string, Buffer>();
    let at = CONTAINER_HEADER;
    while (at < total) {
        if (at + RECORD_HEADER > total) throw new WdtCodecError("truncated record header", at);
        const tag = packet.toString("ascii", at, at + TAG_BYTES);
        const length = packet.readUInt16BE(at + 6);
        const padded = (length + 3) & ~3;
        const start = at + RECORD_HEADER;
        if (start + padded > total) throw new WdtCodecError(`record ${tag} overruns the container`, at);
        records.set(tag, packet.subarray(start, start + length));
        at = start + padded;
    }
    return records;
}

export function readU32(records: Map<string, Buffer>, tag: string, fallback = 0): number {
    const value = records.get(tag);
    if (!value || value.length < 4) return fallback;
    return value.readUInt32LE(0);
}

export function readU8(records: Map<string, Buffer>, tag: string, fallback = 0): number {
    const value = records.get(tag);
    return value && value.length >= 1 ? value[0] : fallback;
}

export function readString(records: Map<string, Buffer>, tag: string, fallback = ""): string {
    const value = records.get(tag);
    if (!value) return fallback;
    const zero = value.indexOf(0);
    return value.toString("utf8", 0, zero >= 0 ? zero : value.length);
}

/** The default 44-byte territory record the client's parser accepts.
 *
 * Every field takes WDTTerritory's constructor default; only the id and the
 * two map coordinates vary. The map code draws from the owner bitmap, while
 * the record supplies the region's identity and art/name index.
 */
export function territoryRecord(id: number, art = 10): Buffer {
    const record = Buffer.alloc(TERRITORY_RECORD_BYTES);
    record[0] = (id >> 8) & 0xff;
    record[1] = id & 0xff;
    record[2] = 0x8a;
    record[3] = 0x8a;
    record[4] = 0x27;
    record[5] = 0x10;
    record[6] = 0x81;
    record[7] = 0x80;
    record[8] = 0x81;
    record[9] = 0x81;
    record[10] = 0x82;
    record[11] = 0x80;
    record.set([0, 100, 50, 0, 100, 50, 0, 100], 12);
    record.set([1, 100, 50, 0, 100, 50, 0, 100, 50], 20);
    record.set([0, 100, 50, 0, 100, 50, 0], 29);
    record.fill(0xff, 36, 44);
    if (art !== 10) record[2] = record[3] = (art + 0x80) & 0xff;
    return record;
}

/** Two bits per cell, row-major, least significant bits first. */
export function encodeOwners(rows: number, territories: number, ownerOf: (territory: number) => number): Buffer {
    const bytes = Math.ceil((rows * territories * 2) / 8);
    const out = Buffer.alloc(bytes);
    for (let row = 0; row < rows; row++) {
        for (let territory = 0; territory < territories; territory++) {
            const owner = ownerOf(territory);
            const value = owner === row ? row & 3 : 0;
            const cell = row * territories + territory;
            out[cell >> 2] |= (value & 3) << ((cell & 3) * 2);
        }
    }
    return out;
}

/** Build the packet OnWDTState hands to the client's WDTState constructor. */
export function encodeState(state: WdtState): Buffer {
    const rows = Math.max(1, state.rows);
    const territories = state.territories.length;
    const records: WdtRecord[] = [];
    if (state.kind === "current") {
        records.push({ tag: "CRTK", value: le32(rows - 1) });
        records.push({ tag: "CYLN", value: le32(Math.max(0, state.lengthDays - 1)) });
        records.push({
            tag: "MPVC",
            value: Buffer.concat(state.territories.map(t => territoryRecord(t.id, t.art))),
        });
        records.push({
            tag: "HSVC",
            value: encodeOwners(rows, territories, (index) => state.ownerOf(state.territories[index])),
        });
        records.push({ tag: "CMID", value: Buffer.from([state.mapId & 0xff]) });
        records.push({ tag: "CYID", value: le32(state.cycleId) });
        records.push({ tag: "TICC", value: le32(territories) });
    } else {
        records.push({ tag: "TOTK", value: le32(rows - 1) });
        records.push({ tag: "CYLN", value: le32(Math.max(0, state.lengthDays - 1)) });
        records.push({
            tag: "HSVC",
            value: encodeOwners(rows, TERRITORIES_PER_CONTINENT, (index) => state.ownerOf(state.territories[index])),
        });
        records.push({ tag: "CMID", value: Buffer.from([state.mapId & 0xff]) });
        records.push({ tag: "CYID", value: le32(state.cycleId) });
    }
    // SDSC/LDSC carry CSF key names (the client resolves them through its
    // localized string table), not display text. The service defaults are the
    // client's own `"WDT:DefaultShortDescription"` / `"WDT:DefaultLongDescription"`.
    const text = (value: string) => Buffer.from(`${value}\0`, "utf8");
    records.push({ tag: "WURL", value: text(state.url) });
    records.push({ tag: "SDSC", value: text(state.shortDescription) });
    records.push({ tag: "LDSC", value: text(state.longDescription) });
    return encodeContainer(records);
}

/** A refusal the client shows as "NACK received from server". */
export function encodeNack(reason = ""): Buffer {
    return encodeContainer([{ tag: "NACK", value: Buffer.from(reason + "\0", "utf8") }]);
}
