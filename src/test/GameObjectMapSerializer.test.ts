import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataStream } from '@/data/DataStream';
import { MixFile } from '@/data/MixFile';
import { IniFile } from '@/data/IniFile';
import { TheaterType } from '@/engine/TheaterType';
import { TerrainType } from '@/engine/type/TerrainType';
import { ObjectType } from '@/engine/type/ObjectType';
import { GameFactory } from '@/game/GameFactory';
import { BoxedVar } from '@/util/BoxedVar';
import { extractMapObjects } from '@/tools/mapEditor/GameObjectMapSerializer';

function loadIniFromMix(mix: MixFile, fileName: string): IniFile {
    return new IniFile(mix.openFile(fileName));
}

const YR_GENERAL_DEFAULTS: Record<string, string> = {
    ParadropPlane: 'PDPLANE',
};

function patchYrGeneralKeys(rulesIni: IniFile): void {
    for (const [key, value] of Object.entries(YR_GENERAL_DEFAULTS)) {
        if (rulesIni.getSection('General')?.has(key) === false) {
            rulesIni.getSection('General')!.set(key, value);
        }
    }
}

function loadMix(): MixFile {
    const mixPath = path.resolve('public/ini.mix');
    if (!fs.existsSync(mixPath)) {
        throw new Error(`public/ini.mix not found at ${mixPath}`);
    }
    return new MixFile(new DataStream(fs.readFileSync(mixPath).buffer));
}

const fakeTileSets: any = {
    getTileImage: () => ({
        terrainType: TerrainType.Clear,
        rampType: 0,
        height: 0,
        radarLeft: { clone: () => ({ multiplyScalar: () => ({}) }) },
    }),
    isCliffTile: () => false,
    isHighBridgeBoundaryTile: () => false,
    getSetNum: () => 0,
    isCLAT: () => false,
    isLAT: () => false,
    getLAT: () => 0,
    getCLATSet: () => 0,
    canConnectTiles: () => false,
    getTileNumFromSet: () => 0,
    getGeneralValue: () => 0,
};

class SyntheticMapFile extends (require('@/data/MapFile').MapFile) {
    constructor(size: number) {
        super();
        const tiles: any[] = [];
        for (let ry = 0; ry < size; ry++) {
            for (let rx = 0; rx < size; rx++) {
                tiles.push({ rx, ry, dx: rx - ry + size - 1, dy: rx + ry - size - 1, z: 0, tileNum: 0, subTile: 0 });
            }
        }
        (this as any).fullSize = { x: 0, y: 0, width: size, height: size };
        (this as any).localSize = { x: 3, y: 3, width: size - 6, height: size - 6 };
        (this as any).theaterType = TheaterType.Temperate;
        (this as any).tiles = tiles;
        (this as any).startingLocations = [{ x: 10, y: 10 }, { x: size - 10, y: size - 10 }];
        (this as any).tags = [];
        (this as any).cellTags = [];
        (this as any).waypoints = [];
        (this as any).lighting = undefined;
        (this as any).ionLighting = undefined;
        (this as any).triggers = [];
        (this as any).variables = [];
        (this as any).terrains = [];
        (this as any).overlays = [];
        (this as any).smudges = [];
        (this as any).structures = [];
        (this as any).infantries = [];
        (this as any).vehicles = [];
        (this as any).aircrafts = [];
        (this as any).specialFlags = { initialVeteran: false };
        (this as any).artOverrides = undefined;
    }
}

function buildMapFile(size: number): any {
    return new SyntheticMapFile(size);
}

function makeGame(mix: MixFile): any {
    const baseRules = loadIniFromMix(mix, 'rules.ini');
    const baseArt = loadIniFromMix(mix, 'art.ini');
    const baseAi = loadIniFromMix(mix, 'ai.ini');
    try {
        baseRules.mergeWith(loadIniFromMix(mix, 'MPBattle.ini'));
    } catch { /* noop */ }
    patchYrGeneralKeys(baseRules);
    const gameOpts: any = {
        gameMode: 0,
        gameSpeed: 5,
        credits: 10000,
        unitCount: 0,
        shortGame: false,
        superWeapons: true,
        buildOffAlly: false,
        mcvRepacks: false,
        cratesAppear: false,
        destroyableBridges: true,
        multiEngineer: false,
        noDogEngiKills: false,
        instantCapture: true,
        delayedOils: false,
        mapName: 'gom-serializer-test.map',
        mapTitle: 'GameObjectMapSerializer Test',
        mapDigest: '',
        mapSizeBytes: 0,
        maxSlots: 2,
        mapOfficial: true,
        humanPlayers: [{ name: 'Tester', countryId: 0, colorId: 0, startPos: 0, teamId: 0 }],
        aiPlayers: new Array(2).fill(undefined),
    };
    const gameModes: any = { getById: () => ({ type: 'Standard' }) };
    return GameFactory.create(
        buildMapFile(60),
        fakeTileSets,
        baseRules,
        baseArt,
        baseAi,
        new IniFile(),
        [],
        1337,
        1337,
        gameOpts,
        gameModes,
        true,
        {},
        { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
        new BoxedVar(false),
        new BoxedVar(0),
    );
}

describe('GameObjectMapSerializer.extractMapObjects', () => {
    test('round-trips a spawned structure and vehicle back into MapObjects data', () => {
        const mix = loadMix();
        const game = makeGame(mix);
        game.init(game.getPlayerByName('Tester'));
        const player = game.getPlayerByName('Tester');

        const rules = game.rules;
        const art = game.art;
        const objectFactory = game.objectFactory;

        const buildingName = [...rules.buildingRules.keys()].find(
            (name: string) => art.hasObject(name, ObjectType.Building) && !rules.getObject(name, ObjectType.Building)?.wall,
        );
        // Excludes MCVs: the game always auto-spawns one starting MCV per
        // human player regardless of gameOpts.unitCount, so picking an MCV
        // type here would make extracted.vehicles.find() below ambiguous
        // between that auto-spawned unit and the one this test places.
        const vehicleName = [...rules.vehicleRules.keys()].find(
            (name: string) => art.hasObject(name, ObjectType.Vehicle)
                && !rules.getObject(name, ObjectType.Vehicle)?.harvester
                && !/mcv/i.test(name),
        );
        expect(buildingName).toBeTruthy();
        expect(vehicleName).toBeTruthy();

        const structureTile = game.map.tiles.getByMapCoords(20, 20);
        const structureObj = objectFactory.create(ObjectType.Building, buildingName, rules, art);
        game.changeObjectOwner(structureObj, player);
        game.spawnObject(structureObj, structureTile);

        const vehicleTile = game.map.tiles.getByMapCoords(25, 25);
        const vehicleObj = objectFactory.create(ObjectType.Vehicle, vehicleName, rules, art);
        game.changeObjectOwner(vehicleObj, player);
        vehicleObj.direction = 90;
        game.spawnObject(vehicleObj, vehicleTile);

        const extracted = extractMapObjects(game.world.getAllObjects());

        const extractedStructure = extracted.structures.find((s) => s.name === buildingName);
        expect(extractedStructure).toBeTruthy();
        expect(extractedStructure!.owner).toBe(player.country.name);
        expect(extractedStructure!.rx).toBe(20);
        expect(extractedStructure!.ry).toBe(20);
        expect(extractedStructure!.health).toBe(256);

        const extractedVehicle = extracted.vehicles.find((v) => v.name === vehicleName);
        expect(extractedVehicle).toBeTruthy();
        expect(extractedVehicle!.owner).toBe(player.country.name);
        expect(extractedVehicle!.rx).toBe(25);
        expect(extractedVehicle!.ry).toBe(25);
        // obj.direction (90 degrees) round-trips through toMapDirection()'s
        // inverse of Game.ts's forward transform
        // (obj.direction = ((-mapValue/256)*360+360)%360) into map-space
        // units (0-255) - expect round((-90 * 256/360) mod 256) = 192,
        // +/-1 for rounding.
        const expectedMapDirection = Math.round((((-90 * 256) / 360) % 256 + 256) % 256);
        expect(Math.abs(extractedVehicle!.direction - expectedMapDirection)).toBeLessThanOrEqual(1);

        game.dispose?.();
    });
});
