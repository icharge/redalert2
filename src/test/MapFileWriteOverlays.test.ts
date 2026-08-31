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

describe('MapFile.writeOverlays', () => {
    test('round-trips a real map\'s [OverlayPack]/[OverlayDataPack] byte-for-byte with zero edits', () => {
        const original = loadRealMap();
        expect(original.overlays.length).toBeGreaterThan(0);

        original.writeOverlays(original.overlays);
        const roundTripped = new MapFile(original.toString());

        expect(roundTripped.overlays.length).toBe(original.overlays.length);
        const key = (o: { rx: number; ry: number }) => `${o.rx},${o.ry}`;
        const byCell = new Map(original.overlays.map((o) => [key(o), o]));
        for (const overlay of roundTripped.overlays) {
            const before = byCell.get(key(overlay));
            expect(before).toBeDefined();
            expect(overlay.id).toBe(before!.id);
            expect(overlay.value).toBe(before!.value);
        }
    });

    test('an edited overlay cell survives the round-trip, and only that cell changes', () => {
        const baseline = loadRealMap();
        const original = loadRealMap();
        const target = original.overlays[0];
        const targetKey = `${target.rx},${target.ry}`;
        const editedId = (target.id + 1) % 255;
        const editedValue = (target.value + 1) % 256;
        target.id = editedId;
        target.value = editedValue;

        original.writeOverlays(original.overlays);
        const roundTripped = new MapFile(original.toString());

        const key = (o: { rx: number; ry: number }) => `${o.rx},${o.ry}`;
        const roundTrippedByCell = new Map(roundTripped.overlays.map((o) => [key(o), o]));
        const after = roundTrippedByCell.get(targetKey);
        expect(after?.id).toBe(editedId);
        expect(after?.value).toBe(editedValue);

        let changedCount = 0;
        const baselineByCell = new Map(baseline.overlays.map((o) => [key(o), o]));
        for (const [cellKey, before] of baselineByCell) {
            const cellAfter = roundTrippedByCell.get(cellKey);
            if (!cellAfter || cellAfter.id !== before.id || cellAfter.value !== before.value) {
                changedCount++;
            }
        }
        expect(changedCount).toBe(1);
    });

    test('a removed overlay cell disappears, and other cells are unaffected', () => {
        const baseline = loadRealMap();
        const original = loadRealMap();
        const [removed, ...remaining] = original.overlays;

        original.writeOverlays(remaining);
        const roundTripped = new MapFile(original.toString());

        expect(roundTripped.overlays.length).toBe(baseline.overlays.length - 1);
        const stillThere = roundTripped.overlays.some((o) => o.rx === removed.rx && o.ry === removed.ry);
        expect(stillThere).toBe(false);
    });
});
