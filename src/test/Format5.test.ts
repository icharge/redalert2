import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Format5 } from '@/data/encoding/Format5';
import { MapFile } from '@/data/MapFile';
import * as stringUtil from '@/util/string';

function randomBytes(size: number, seed = 1): Uint8Array {
    const out = new Uint8Array(size);
    let state = seed;
    for (let i = 0; i < size; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = state & 0xff;
    }
    return out;
}

describe('Format5.encode/decode round-trip (synthetic)', () => {
    const cases: Record<string, Uint8Array> = {
        'empty input': new Uint8Array(0),
        '1 byte': new Uint8Array([42]),
        'exactly one chunk (8192 bytes, random)': randomBytes(Format5.CHUNK_SIZE),
        'one chunk + 1 byte (forces a second, tiny chunk)': randomBytes(Format5.CHUNK_SIZE + 1),
        'several chunks, random data': randomBytes(Format5.CHUNK_SIZE * 3 + 777),
        'several chunks, all zero (highly compressible)': new Uint8Array(Format5.CHUNK_SIZE * 2 + 100),
    };

    for (const format of [5, 80] as const) {
        describe(`format ${format}`, () => {
            for (const [name, original] of Object.entries(cases)) {
                test(name, () => {
                    const encoded = Format5.encode(original, format);
                    const decoded = Format5.decode(encoded, original.length, format);
                    expect(decoded).toEqual(original);
                });
            }
        });
    }
});

describe('Format5 against a real .map file', () => {
    // A real official RA2 campaign mission map (not a synthetic fixture) -
    // gives the encoder genuine multi-chunk, non-trivial terrain/overlay
    // data to round-trip against, closing the "only ever tested against
    // synthetic fixtures" gap flagged in docs/map-editor-feasibility-and-
    // design.md's cross-phase risks.
    const mapPath = path.resolve('src/test/fixtures/campaign-sample.map');

    function loadRealMap(): MapFile {
        if (!fs.existsSync(mapPath)) {
            throw new Error(`Real map fixture not found at ${mapPath}`);
        }
        return new MapFile(fs.readFileSync(mapPath, 'utf-8'));
    }

    test('[IsoMapPack5] (format 5, LZO1X): decode -> re-encode -> decode reproduces the same terrain bytes', () => {
        const mapFile = loadRealMap();
        const section = mapFile.getSection('IsoMapPack5');
        if (!section) {
            throw new Error('Fixture map has no [IsoMapPack5] section');
        }
        const compressed = stringUtil.base64StringToUint8Array(section.getConcatenatedValues());
        const tileCount = (2 * mapFile.fullSize.width - 1) * mapFile.fullSize.height;
        const decoded = new Uint8Array(11 * tileCount + 4);
        Format5.decodeInto(compressed, decoded);

        const reEncoded = Format5.encode(decoded, 5);
        const reDecoded = new Uint8Array(decoded.length);
        Format5.decodeInto(reEncoded, reDecoded);

        expect(reDecoded).toEqual(decoded);
    });

    test('[OverlayPack]/[OverlayDataPack] (format 80, LCW): decode -> re-encode -> decode reproduces the same overlay bytes', () => {
        const mapFile = loadRealMap();
        for (const sectionName of ['OverlayPack', 'OverlayDataPack']) {
            const section = mapFile.getSection(sectionName);
            if (!section) {
                throw new Error(`Fixture map has no [${sectionName}] section`);
            }
            const compressed = stringUtil.base64StringToUint8Array(section.getConcatenatedValues());
            const decoded = new Uint8Array(1 << 18);
            Format5.decodeInto(compressed, decoded, 80);

            const reEncoded = Format5.encode(decoded, 80);
            const reDecoded = new Uint8Array(decoded.length);
            Format5.decodeInto(reEncoded, reDecoded, 80);

            expect(reDecoded).toEqual(decoded);
        }
    });
});
