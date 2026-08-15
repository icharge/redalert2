#!/usr/bin/env bun
/**
 * CSF CLI — manipulate Command & Conquer string files (.csf, RA2/YR format).
 *
 * Usage:
 *   bun tools/csf.ts <command> [options]
 *
 * Commands:
 *   keys       <file>              List label keys (one per line)
 *             [-v|--values]        Include values (tab-separated)
 *             [-c|--count]         Print only the number of keys
 *   get        <file> <key>        Print the value of one key (case-insensitive)
 *   subtract   <target> <minus>    Remove from <target> every key present in <minus>
 *             [-o <out>]           Write result to <out> instead of in place
 *             [--backup]           Save the original <target> as <target>.bak
 *   diff       <a> <b>             Print keys unique to each file
 *   to-json    <file>              Dump the whole file as JSON (value, extra fields)
 *   from-json  <file.json>         Build a CSF from JSON (use - for stdin)
 *             [-o <out>]           Output path (default: <file.json> with .csf)
 *
 * Format notes:
 *   - Keys match case-insensitively (mirrors src/data/CsfFile.ts).
 *   - Values are XOR-encoded UTF-16LE.
 *   - Two value magics exist: " RTS" (plain value) and "WRTS"/"STRW" (value
 *     plus an extra raw byte string, e.g. alternate voice files). Extra bytes
 *     are preserved verbatim via base64 in JSON and on splice operations.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const MAGIC = {
  FSC: 0x43534620, // " FSC"
  LBL: 0x4c424c20, // " LBL"
  RTS: 0x53545220, // " RTS"
  WRTS: 0x53545257, // "WRTS"
  STRW: 0x57525453, // "STRW"
} as const;

interface CsfHeader {
  version: number;
  language: number;
}

interface CsfEntry {
  /** Original-case label name. */
  name: string;
  /** Decoded label value. */
  value: string;
  /** Raw extra string bytes (WRTS/STRW entries only), base64-encoded. */
  extra?: string;
  /** Byte range in the source buffer (end exclusive), for splice operations. */
  start: number;
  end: number;
}

interface CsfFile {
  header: CsfHeader;
  entries: CsfEntry[];
  /** Source buffer; entries reference byte ranges into it. */
  buffer: Buffer;
}

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

/** TextEncoder/Decoder cover latin1 for 0x80-0xFF by round-tripping code points. */
const latin1 = {
  decode: (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes),
  encode: (text: string): Uint8Array => new TextEncoder().encode(text),
};

function decodeXorUtf16(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 2) {
    const lo = (~bytes[i]) & 0xff;
    const hi = (~bytes[i + 1]) & 0xff;
    result += String.fromCharCode(lo | (hi << 8));
  }
  return result;
}

function encodeXorUtf16(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    bytes[i * 2] = (~c) & 0xff;
    bytes[i * 2 + 1] = (~(c >> 8)) & 0xff;
  }
  return bytes;
}

function parseCsf(buffer: Buffer): CsfFile {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = 0;
  const i32 = (): number => {
    const v = dv.getInt32(p, true);
    p += 4;
    return v;
  };

  if (i32() !== MAGIC.FSC) fail(`not a CSF file (bad header magic)`);
  const version = i32();
  const numLabels = i32();
  i32(); // numStrings
  i32(); // numLanguages
  const language = i32();

  const entries: CsfEntry[] = [];
  for (let i = 0; i < numLabels; i++) {
    const start = p;
    if (i32() !== MAGIC.LBL) fail(`bad " LBL" magic at entry ${i} (offset ${start})`);
    const numPairs = i32();
    if (numPairs !== 1) fail(`entry ${i} has ${numPairs} value pairs; only 1 is supported`);
    const nameLen = i32();
    if (nameLen < 0 || p + nameLen > buffer.length) fail(`invalid label name length ${nameLen} at entry ${i}`);
    const name = latin1.decode(buffer.subarray(p, p + nameLen));
    p += nameLen;
    const valueMagic = i32();
    const charsLen = i32();
    if (charsLen < 0 || p + charsLen * 2 > buffer.length) fail(`invalid value length ${charsLen} at entry ${i} (${name})`);
    const valueBytes = buffer.subarray(p, p + charsLen * 2);
    p += charsLen * 2;
    let extra: string | undefined;
    if (valueMagic === MAGIC.WRTS || valueMagic === MAGIC.STRW) {
      const extraBytesLen = i32();
      if (extraBytesLen < 0 || p + extraBytesLen > buffer.length) fail(`invalid extra length ${extraBytesLen} at entry ${i} (${name})`);
      extra = buffer.subarray(p, p + extraBytesLen).toString('base64');
      p += extraBytesLen;
    } else if (valueMagic !== MAGIC.RTS) {
      fail(`unknown value magic 0x${valueMagic.toString(16)} at entry ${i} (${name})`);
    }
    entries.push({ name, value: decodeXorUtf16(valueBytes), extra, start, end: p });
  }
  if (p !== buffer.length) fail(`parsed ${p} bytes but file has ${buffer.length} (${buffer.length - p} unparsed)`);
  return { header: { version, language }, entries, buffer };
}

function buildCsf(header: CsfHeader, entries: { name: string; value: string; extra?: string }[]): Buffer {
  const parts: Buffer[] = [];
  const headerBuf = new ArrayBuffer(24);
  const dv = new DataView(headerBuf);
  dv.setInt32(0, MAGIC.FSC, true);
  dv.setInt32(4, header.version, true);
  dv.setInt32(8, entries.length, true);
  dv.setInt32(12, entries.length, true);
  dv.setInt32(16, 0, true);
  dv.setInt32(20, header.language, true);
  parts.push(Buffer.from(new Uint8Array(headerBuf)));
  for (const entry of entries) {
    const name = latin1.encode(entry.name);
    const label = Buffer.alloc(12);
    const ldv = new DataView(label.buffer);
    ldv.setInt32(0, MAGIC.LBL, true);
    ldv.setInt32(4, 1, true);
    ldv.setInt32(8, name.length, true);
    parts.push(label, Buffer.from(name));
    const hasExtra = entry.extra !== undefined;
    const valueHead = Buffer.alloc(8);
    const vdv = new DataView(valueHead.buffer);
    vdv.setInt32(0, hasExtra ? MAGIC.WRTS : MAGIC.RTS, true);
    vdv.setInt32(4, entry.value.length, true);
    parts.push(valueHead, Buffer.from(encodeXorUtf16(entry.value)));
    if (hasExtra) {
      const extraBytes = Buffer.from(entry.extra!, 'base64');
      const extraLen = Buffer.alloc(4);
      new DataView(extraLen.buffer).setInt32(0, extraBytes.length, true);
      parts.push(extraLen, extraBytes);
    }
  }
  return Buffer.concat(parts);
}

/** Keep only the byte ranges of `kept` entries, splicing them verbatim. */
function splice(parsed: CsfFile, kept: CsfEntry[]): Buffer {
  const parts: Buffer[] = [];
  const headerBuf = new ArrayBuffer(24);
  const dv = new DataView(headerBuf);
  dv.setInt32(0, MAGIC.FSC, true);
  dv.setInt32(4, parsed.header.version, true);
  dv.setInt32(8, kept.length, true);
  dv.setInt32(12, kept.length, true);
  dv.setInt32(16, 0, true);
  dv.setInt32(20, parsed.header.language, true);
  parts.push(Buffer.from(new Uint8Array(headerBuf)));
  for (const entry of kept) parts.push(parsed.buffer.subarray(entry.start, entry.end));
  return Buffer.concat(parts);
}

const keySet = (entries: CsfEntry[]): Set<string> => new Set(entries.map((e) => e.name.toUpperCase()));

function readJson(path: string): unknown {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

function writeJson(path: string, value: unknown): void {
  if (path === '-') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  }
}

// --- Commands ---------------------------------------------------------------

function cmdKeys(args: string[]): void {
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const file = args.find((a) => !a.startsWith('-')) ?? fail(`keys: missing <file>`, 2);
  const parsed = parseCsf(readFileSync(file));
  if (flags.has('-c') || flags.has('--count')) {
    console.log(parsed.entries.length);
    return;
  }
  const withValues = flags.has('-v') || flags.has('--values');
  for (const { name, value } of parsed.entries) {
    console.log(withValues ? `${name}\t${value}` : name);
  }
}

function cmdGet(args: string[]): void {
  const [file, key] = args;
  if (!file || !key) fail(`get: expected <file> <key>`, 2);
  const parsed = parseCsf(readFileSync(file));
  const found = parsed.entries.find((e) => e.name.toUpperCase() === key.toUpperCase());
  if (!found) fail(`key "${key}" not found in ${file}`);
  console.log(found.value);
}

function cmdSubtract(args: string[]): void {
  const target = args.find((a) => !a.startsWith('-'));
  const rest = args.filter((a) => !a.startsWith('-')).filter((a) => a !== target);
  const minus = rest[0];
  if (!target || !minus) fail(`subtract: expected <target> <minus>`, 2);
  const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : undefined;
  const backup = args.includes('--backup');

  const targetParsed = parseCsf(readFileSync(target));
  const minusKeys = keySet(parseCsf(readFileSync(minus)).entries);
  const kept = targetParsed.entries.filter((e) => !minusKeys.has(e.name.toUpperCase()));
  const removed = targetParsed.entries.length - kept.length;
  const dest = out ?? target;

  console.log(`${minus} keys: ${minusKeys.size}`);
  console.log(`${target} keys: ${targetParsed.entries.length} -> ${kept.length} (removed ${removed})`);
  if (removed === 0) {
    console.log('No keys to remove; file left untouched.');
    return;
  }
  if (!out && backup) copyFileSync(target, `${target}.bak`);
  writeFileSync(dest, splice(targetParsed, kept));
  console.log(`Written ${dest} (${kept.length} keys)`);
}

function cmdDiff(args: string[]): void {
  const [a, b] = args;
  if (!a || !b) fail(`diff: expected <a> <b>`, 2);
  const aKeys = keySet(parseCsf(readFileSync(a)).entries);
  const bKeys = keySet(parseCsf(readFileSync(b)).entries);
  const onlyA = [...aKeys].filter((k) => !bKeys.has(k)).sort();
  const onlyB = [...bKeys].filter((k) => !aKeys.has(k)).sort();
  console.log(`Only in ${a} (${onlyA.length}):`);
  for (const k of onlyA) console.log(`  ${k}`);
  console.log(`Only in ${b} (${onlyB.length}):`);
  for (const k of onlyB) console.log(`  ${k}`);
}

function cmdToJson(args: string[]): void {
  const file = args.find((a) => !a.startsWith('-')) ?? fail(`to-json: missing <file>`, 2);
  const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : '-';
  const parsed = parseCsf(readFileSync(file));
  const entries = parsed.entries.map(({ name, value, extra }) => ({ name, value, ...(extra ? { extra } : {}) }));
  writeJson(out, { version: parsed.header.version, language: parsed.header.language, entries });
}

function cmdFromJson(args: string[]): void {
  const file = args.find((a) => !a.startsWith('-')) ?? fail(`from-json: missing <file.json>`, 2);
  const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : file.replace(/\.json$/, '') + '.csf';
  const json = readJson(file) as {
    version?: number;
    language?: number;
    entries?: { name: string; value: string; extra?: string }[];
    [key: string]: unknown;
  };
  let entries: { name: string; value: string; extra?: string }[];
  if (Array.isArray(json.entries)) {
    entries = json.entries.map((e) => {
      if (typeof e.name !== 'string' || typeof e.value !== 'string') fail('from-json: every entry needs string "name" and "value"');
      return { name: e.name, value: e.value, ...(typeof e.extra === 'string' ? { extra: e.extra } : {}) };
    });
  } else {
    // Flat { key: value } convenience form.
    entries = Object.entries(json).map(([name, value]) => {
      if (typeof value !== 'string') fail(`from-json: value for "${name}" must be a string`);
      return { name, value };
    });
  }
  const header: CsfHeader = {
    version: typeof json.version === 'number' ? json.version : 3,
    language: typeof json.language === 'number' ? json.language : 0,
  };
  writeFileSync(out, buildCsf(header, entries));
  console.log(`Written ${out} (${entries.length} keys)`);
}

const HELP = `CSF CLI — manipulate Command & Conquer string files (.csf, RA2/YR format).

Usage:
  bun tools/csf.ts <command> [options]

Commands:
  keys       <file>              List label keys (one per line)
             [-v|--values]        Include values (tab-separated)
             [-c|--count]         Print only the number of keys
  get        <file> <key>        Print the value of one key (case-insensitive)
  subtract   <target> <minus>    Remove from <target> every key present in <minus>
             [-o <out>]           Write result to <out> instead of in place
             [--backup]           Save the original <target> as <target>.bak
  diff       <a> <b>             Print keys unique to each file
  to-json    <file>              Dump the whole file as JSON (value, extra fields)
  from-json  <file.json>         Build a CSF from JSON (use - for stdin)
             [-o <out>]           Output path (default: <file.json> with .csf)

Format notes:
  - Keys match case-insensitively (mirrors src/data/CsfFile.ts).
  - Values are XOR-encoded UTF-16LE.
  - Two value magics exist: " RTS" (plain value) and "WRTS"/"STRW" (value
    plus an extra raw byte string, e.g. alternate voice files). Extra bytes
    are preserved verbatim via base64 in JSON and on splice operations.`;

// --- Main -------------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'keys': cmdKeys(args); break;
  case 'get': cmdGet(args); break;
  case 'subtract': cmdSubtract(args); break;
  case 'diff': cmdDiff(args); break;
  case 'to-json': cmdToJson(args); break;
  case 'from-json': cmdFromJson(args); break;
  case '-h': case '--help': case undefined:
    console.log(HELP);
    break;
  default: fail(`unknown command "${command}"`, 2);
}
