import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MapFile } from '@/data/MapFile';

function loadRealMap(): MapFile {
    const mapPath = path.resolve('src/test/fixtures/campaign-sample.map');
    if (!fs.existsSync(mapPath)) {
        throw new Error(`Real map fixture not found at ${mapPath}`);
    }
    return new MapFile(fs.readFileSync(mapPath, 'utf-8'));
}

describe('MapFile.writeTiles', () => {
    test('round-trips a real map\'s [IsoMapPack5] byte-for-byte with zero edits', () => {
        const original = loadRealMap();
        expect(original.tiles.length).toBeGreaterThan(0);

        original.writeTiles(original.tiles);
        const roundTripped = new MapFile(original.toString());

        expect(roundTripped.tiles.length).toBe(original.tiles.length);
        for (let i = 0; i < original.tiles.length; i++) {
            expect(roundTripped.tiles[i]).toEqual(original.tiles[i]);
        }
    });

    test('an edited tile survives the round-trip, and only that tile changes', () => {
        const baseline = loadRealMap();
        const original = loadRealMap();
        const target = original.tiles[0];
        const targetKey = `${target.rx},${target.ry}`;
        const editedTileNum = (target.tileNum + 1) % 256;
        const editedSubTile = (target.subTile + 1) % 4;
        target.tileNum = editedTileNum;
        target.subTile = editedSubTile;

        original.writeTiles(original.tiles);
        const roundTripped = new MapFile(original.toString());

        let changedCount = 0;
        for (let i = 0; i < baseline.tiles.length; i++) {
            const before = baseline.tiles[i];
            const after = roundTripped.tiles[i];
            if (`${before.rx},${before.ry}` === targetKey) {
                expect(after.tileNum).toBe(editedTileNum);
                expect(after.subTile).toBe(editedSubTile);
            }
            if (after.tileNum !== before.tileNum || after.subTile !== before.subTile) {
                changedCount++;
            }
        }
        expect(changedCount).toBe(1);
    });

    test('preserves the ice-growth byte instead of silently zeroing it', () => {
        const original = loadRealMap();
        const target = original.tiles.find((t) => t.iceGrowth === 0) ?? original.tiles[0];
        target.iceGrowth = 200;

        original.writeTiles(original.tiles);
        const roundTripped = new MapFile(original.toString());

        const after = roundTripped.tiles.find((t) => t.rx === target.rx && t.ry === target.ry);
        expect(after?.iceGrowth).toBe(200);
    });
});
