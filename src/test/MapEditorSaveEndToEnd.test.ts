import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataStream } from '@/data/DataStream';
import { MixFile } from '@/data/MixFile';
import { IniFile } from '@/data/IniFile';
import { MapFile } from '@/data/MapFile';
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

// This fixture doubles as the MapFile that steps 5-7 will eventually load
// into the editor tool - it carries a real IniFile-backed [Basic] section
// (untouched by the save pipeline) alongside the synthetic map/tile state
// GameFactory.create needs to boot a real Game.
class SyntheticMapFile extends (MapFile as any) {
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

        // An untouched section that the save pipeline must round-trip
        // byte-for-byte, since MapEditorTester (step 6) will only ever
        // touch the four techno-object sections.
        const basicSection = this.getOrCreateSection('Basic');
        basicSection.set('Name', 'Save Pipeline Fixture');
        basicSection.set('Author', 'redalert2-web');
    }
}

function buildMapFile(size: number): any {
    return new SyntheticMapFile(size);
}

function makeGame(mix: MixFile, mapFile: any): any {
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
        mapName: 'save-e2e-test.map',
        mapTitle: 'MapEditorSaveEndToEnd Test',
        mapDigest: '',
        mapSizeBytes: 0,
        maxSlots: 2,
        mapOfficial: true,
        humanPlayers: [{ name: 'Tester', countryId: 0, colorId: 0, startPos: 0, teamId: 0 }],
        aiPlayers: new Array(2).fill(undefined),
    };
    const gameModes: any = { getById: () => ({ type: 'Standard' }) };
    return GameFactory.create(
        mapFile,
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

describe('Phase 1 step 4: save pipeline end-to-end', () => {
    test('MapFile fixture -> boot game -> place object -> extract -> write -> toString contains it', () => {
        const mix = loadMix();
        const mapFile = buildMapFile(60);
        const game = makeGame(mix, mapFile);
        game.init(game.getPlayerByName('Tester'));
        const player = game.getPlayerByName('Tester');

        const rules = game.rules;
        const art = game.art;
        const objectFactory = game.objectFactory;

        const buildingName = [...rules.buildingRules.keys()].find(
            (name: string) => art.hasObject(name, ObjectType.Building) && !rules.getObject(name, ObjectType.Building)?.wall,
        );
        expect(buildingName).toBeTruthy();

        // Place one new object the way MapEditorTester's placement controller
        // will in step 6 - via the live Game/spawnObject path, not by
        // touching MapFile directly.
        const structureTile = game.map.tiles.getByMapCoords(33, 17);
        const structureObj = objectFactory.create(ObjectType.Building, buildingName, rules, art);
        game.changeObjectOwner(structureObj, player);
        game.spawnObject(structureObj, structureTile);

        // Full save pipeline: live GameObjects -> extractor -> MapFile writers -> toString().
        const extracted = extractMapObjects(game.world.getAllObjects());
        mapFile.writeStructures(extracted.structures);
        mapFile.writeVehicles(extracted.vehicles);
        mapFile.writeInfantries(extracted.infantries);
        mapFile.writeAircrafts(extracted.aircrafts);

        const output: string = mapFile.toString();

        const structuresSectionText = output.slice(
            output.indexOf('[Structures]'),
            output.indexOf('[', output.indexOf('[Structures]') + 1) === -1
                ? undefined
                : output.indexOf('[', output.indexOf('[Structures]') + 1),
        );
        expect(structuresSectionText).toContain(buildingName);
        expect(structuresSectionText).toContain(`${player.country.name},${buildingName}`);
        expect(structuresSectionText).toContain('33,17');

        // The untouched [Basic] section must survive byte-for-byte - the
        // save pipeline only ever calls write* on the four techno sections.
        expect(output).toContain('[Basic]');
        expect(output).toContain('Name=Save Pipeline Fixture');
        expect(output).toContain('Author=redalert2-web');

        game.dispose?.();
    });
});
