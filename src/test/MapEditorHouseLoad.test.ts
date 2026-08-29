import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataStream } from '@/data/DataStream';
import { MixFile } from '@/data/MixFile';
import { IniFile } from '@/data/IniFile';
import { TheaterType } from '@/engine/TheaterType';
import { TerrainType } from '@/engine/type/TerrainType';
import { GameFactory } from '@/game/GameFactory';
import { Country } from '@/game/Country';
import { PlayerFactory } from '@/game/player/PlayerFactory';
import { ProductionTrait } from '@/game/trait/ProductionTrait';
import { BoxedVar } from '@/util/BoxedVar';
import { Structure } from '@/data/MapObjects';

// Exercises the exact mechanism MapEditorTester.createGame()/buildHousePlayers()
// use (same Game.ts GameInitOptions.includeNonNeutralMapTechnos flag, same
// Country.factory + PlayerFactory.createCombatant construction pattern) so
// this can run headless in bun:test - MapEditorTester itself is DOM/WebGL-
// heavy (Renderer, canvas, document) and isn't unit-testable the same way
// SceneSandboxTester (which it's modeled on) also has no test coverage.
// See docs/map-editor-feasibility-and-design.md and the Phase 1 plan for
// why this was an open risk: Game.createInitialMapTechnos silently drops
// any map-placed object whose owner isn't a neutral house, which is correct
// for live multiplayer matches but wrong for an editor loading real map
// content that includes house-owned pre-placed objects.

function loadIniFromMix(mix: MixFile, fileName: string): IniFile {
    return new IniFile(mix.openFile(fileName));
}

const YR_GENERAL_DEFAULTS: Record<string, string> = { ParadropPlane: 'PDPLANE' };
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
    constructor(size: number, structures: Structure[]) {
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
        (this as any).structures = structures;
        (this as any).infantries = [];
        (this as any).vehicles = [];
        (this as any).aircrafts = [];
        (this as any).specialFlags = { initialVeteran: false };
        (this as any).artOverrides = undefined;
    }
}

function makeStructure(owner: string, name: string, rx: number, ry: number): Structure {
    const s = new Structure();
    s.owner = owner;
    s.name = name;
    s.health = 256;
    s.rx = rx;
    s.ry = ry;
    s.direction = 0;
    s.poweredOn = true;
    return s;
}

describe('MapEditorTester house-player mechanism (Game.ts includeNonNeutralMapTechnos)', () => {
    test('loads neutral- and house-owned pre-placed structures with no bogus starting units', () => {
        const mix = loadMix();
        const baseRules = loadIniFromMix(mix, 'rules.ini');
        const baseArt = loadIniFromMix(mix, 'art.ini');
        const baseAi = loadIniFromMix(mix, 'ai.ini');
        try {
            baseRules.mergeWith(loadIniFromMix(mix, 'MPBattle.ini'));
        }
        catch { /* noop */ }
        patchYrGeneralKeys(baseRules);

        // A building name valid for both Allied and Soviet-side houses -
        // GAPILE (Allied Barracks) is used purely as a generic placeable
        // structure here, ownership is what's under test, not art/rules
        // validity per house.
        const structures = [
            makeStructure('Neutral', 'GAPILE', 5, 5),
            makeStructure('Russians', 'GAPILE', 15, 15),
            makeStructure('Alliance', 'GAPILE', 25, 25),
        ];
        const mapFile: any = new SyntheticMapFile(60, structures);

        const gameModes: any = { getById: () => ({ type: 'Standard' }) };
        const gameOpts: any = {
            gameMode: 0,
            gameSpeed: 5,
            credits: 0,
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
            mapName: 'house-load-test.map',
            mapTitle: 'House Load Test',
            mapDigest: '',
            mapSizeBytes: 0,
            maxSlots: 2,
            mapOfficial: true,
            humanPlayers: [{ name: 'Map Editor', countryId: 0, colorId: 0, startPos: 0, teamId: 0 }],
            aiPlayers: [],
        };
        const game = GameFactory.create(
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

        // --- Replicates MapEditorTester.buildHousePlayers() exactly ---
        const editorPlayer = game.getPlayerByName('Map Editor');
        const neutralPlayer = game.playerList.getAll().find((p: any) => p.isNeutral);
        const neutralCountryName = neutralPlayer?.country?.name;
        const editorCountryName = editorPlayer.country?.name;
        expect(neutralCountryName).toBe('Neutral');

        const referencedNames = new Set<string>();
        for (const s of mapFile.structures) {
            referencedNames.add(s.owner);
        }
        for (const country of game.rules.getMultiplayerCountries()) {
            referencedNames.add(country.name);
        }
        referencedNames.delete(neutralCountryName);
        referencedNames.delete(editorCountryName);

        const productionTrait = game.traits.get(ProductionTrait) as unknown as ProductionTrait;
        const playerFactory = new PlayerFactory(game.rules, game.gameOpts, productionTrait.getAvailableObjects());
        const housePlayers = new Map<string, any>();
        for (const name of referencedNames) {
            const country = Country.factory(name, game.rules as unknown as Parameters<typeof Country.factory>[1]);
            const color = game.rules.colors.get('LightGrey');
            const player = playerFactory.createCombatant(name, country, 0, color, false, undefined, undefined);
            game.addPlayer(player);
            housePlayers.set(name, player);
        }
        expect(housePlayers.has('Russians')).toBe(true);
        expect(housePlayers.has('Alliance')).toBe(true);
        expect(housePlayers.has('Neutral')).toBe(false);
        // "Americans" is countryId 0 in getMultiplayerCountries() (same
        // index the editor player itself was created with above), so it's
        // excluded here - real map objects owned by "Americans" resolve to
        // the editor's own player, not a separate phantom one.
        expect(housePlayers.has('Americans')).toBe(false);
        expect(editorCountryName).toBe('Americans');

        game.checkGameEndConditions = () => undefined;
        game.updateDefeatedPlayers = () => undefined;
        game.createPlayerInitialUnits = () => undefined;
        game.init(editorPlayer, { includeNonNeutralMapTechnos: true });

        const allStructures = game.world.getAllObjects().filter((o: any) => o.isBuilding?.());
        expect(allStructures.length).toBe(3);

        const byTile = (rx: number, ry: number) => allStructures.find((o: any) => o.tile?.rx === rx && o.tile?.ry === ry);
        expect(byTile(5, 5)?.owner?.country?.name).toBe('Neutral');
        expect(byTile(15, 15)?.owner?.country?.name).toBe('Russians');
        expect(byTile(25, 25)?.owner?.country?.name).toBe('Alliance');

        // No bogus starting MCV/units for the editor player or any house
        // player - createPlayerInitialUnits was no-op'd, so only the 3
        // pre-placed structures above should exist.
        const allUnits = game.world.getAllObjects().filter((o: any) => o.isUnit?.());
        expect(allUnits.length).toBe(0);

        game.dispose?.();
    });
});
