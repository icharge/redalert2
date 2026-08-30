import { describe, test, expect } from 'bun:test';
import { TileCollection } from '@/game/map/TileCollection';
import type { TileData } from '@/game/map/TileCollection';
import { TerrainType } from '@/engine/type/TerrainType';
import { LandType } from '@/game/type/LandType';

// tileNum 0 -> Clear, tileNum 1 -> Water. subTile is passed straight through
// to terrainByTileNum below, so it never has to match a real TMP layout.
const terrainByTileNum: Record<number, TerrainType> = {
    0: TerrainType.Clear,
    1: TerrainType.Water,
};

function makeTileSets() {
    return {
        getTileImage: (tileNum: number, _subTile: number, _randomIndexSelector: (min: number, max: number) => number) => {
            const terrainType = terrainByTileNum[tileNum];
            if (terrainType === undefined) {
                throw new Error(`TileNum ${tileNum} not found`);
            }
            return {
                terrainType,
                rampType: 0,
                height: 0,
                radarLeft: { clone: () => ({ multiplyScalar: () => ({}) }) },
            };
        },
        isCliffTile: () => false,
        isHighBridgeBoundaryTile: () => false,
    };
}

function makeTileCollection(size = 3): TileCollection {
    const tileData: TileData[] = [];
    for (let ry = 0; ry < size; ry++) {
        for (let rx = 0; rx < size; rx++) {
            tileData.push({ rx, ry, dx: rx - ry + size - 1, dy: rx + ry - size - 1, z: 0, tileNum: 0, subTile: 0 });
        }
    }
    return new TileCollection(tileData, makeTileSets(), { cliffBackImpassability: 0 }, () => 0);
}

describe('TileCollection.repaintTile', () => {
    test('mutates tileNum/subTile/terrainType/landType/rampType in place, leaving position fields untouched', () => {
        const tiles = makeTileCollection();
        const before = tiles.getByMapCoords(1, 1);
        expect(before?.terrainType).toBe(TerrainType.Clear);
        expect(before?.landType).toBe(LandType.Clear);

        const repainted = tiles.repaintTile(1, 1, 1, 2, () => 0);

        expect(repainted.tileNum).toBe(1);
        expect(repainted.subTile).toBe(2);
        expect(repainted.terrainType).toBe(TerrainType.Water);
        expect(repainted.landType).toBe(LandType.Water);
        expect(repainted.rx).toBe(1);
        expect(repainted.ry).toBe(1);
        expect(repainted.z).toBe(0);
    });

    test('the same object reference is mutated in both the rx/ry and dx/dy lookup tables', () => {
        const tiles = makeTileCollection();
        const byMapCoords = tiles.getByMapCoords(1, 1)!;
        const byDisplayCoords = tiles.getByDisplayCoords(byMapCoords.dx, byMapCoords.dy)!;
        expect(byDisplayCoords).toBe(byMapCoords);

        tiles.repaintTile(1, 1, 1, 0, () => 0);

        const afterByMapCoords = tiles.getByMapCoords(1, 1)!;
        const afterByDisplayCoords = tiles.getByDisplayCoords(byMapCoords.dx, byMapCoords.dy)!;
        expect(afterByMapCoords).toBe(byMapCoords);
        expect(afterByDisplayCoords).toBe(byMapCoords);
        expect(afterByMapCoords.tileNum).toBe(1);
        expect(afterByDisplayCoords.tileNum).toBe(1);
    });

    test('repainting one tile does not affect its neighbours', () => {
        const tiles = makeTileCollection();
        const neighbour = tiles.getByMapCoords(0, 1)!;

        tiles.repaintTile(1, 1, 1, 0, () => 0);

        expect(neighbour.tileNum).toBe(0);
        expect(neighbour.terrainType).toBe(TerrainType.Clear);
    });

    test('throws for coordinates outside the map instead of silently no-oping', () => {
        const tiles = makeTileCollection();
        expect(() => tiles.repaintTile(99, 99, 1, 0, () => 0)).toThrow();
    });

    test('throws for an unknown tileNum, same as the constructor path', () => {
        const tiles = makeTileCollection();
        expect(() => tiles.repaintTile(1, 1, 999, 0, () => 0)).toThrow();
    });
});
