import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataStream } from '@/data/DataStream';
import { MixFile } from '@/data/MixFile';
import { IniFile } from '@/data/IniFile';
import { TheaterType } from '@/engine/TheaterType';
import { TerrainType } from '@/engine/type/TerrainType';
import { GameFactory } from '@/game/GameFactory';
import { AiDifficulty } from '@/game/gameopts/GameOpts';
import { BoxedVar } from '@/util/BoxedVar';

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
                tiles.push({
                    rx,
                    ry,
                    dx: rx - ry + size - 1,
                    dy: rx + ry - size - 1,
                    z: 0,
                    tileNum: 0,
                    subTile: 0,
                });
            }
        }
        const quarter = Math.floor(size / 4);
        (this as any).fullSize = { x: 0, y: 0, width: size, height: size };
        (this as any).localSize = { x: 3, y: 3, width: size - 6, height: size - 6 };
        (this as any).theaterType = TheaterType.Temperate;
        (this as any).tiles = tiles;
        (this as any).startingLocations = [
            { x: quarter, y: quarter },
            { x: size - quarter, y: size - quarter },
            { x: size - quarter, y: quarter },
            { x: quarter, y: size - quarter },
        ];
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

function makeGame(mix: MixFile, names: string[], teamOf: (name: string) => number, modRulesName?: string): any {
    const baseRules = loadIniFromMix(mix, 'rules.ini');
    const baseArt = loadIniFromMix(mix, 'art.ini');
    const baseAi = loadIniFromMix(mix, 'ai.ini');
    let modRules = new IniFile();
    if (modRulesName) {
        modRules = loadIniFromMix(mix, modRulesName);
    } else {
        try {
            modRules.mergeWith(loadIniFromMix(mix, 'MPBattle.ini'));
        } catch { /* noop */ }
    }
    baseRules.mergeWith(modRules);
    patchYrGeneralKeys(baseRules);
    const rules = new (require('@/game/rules/Rules').Rules)(baseRules);
    const countries = rules.getMultiplayerCountries().map((c: any) => c.name);
    const colors = [...rules.getMultiplayerColors().keys()];
    const american = Math.max(0, countries.findIndex((n: string) => /americ|alliance|british/i.test(n)));
    const russian = Math.max(0, countries.findIndex((n: string) => /russia|confederation|soviet/i.test(n)));
    const redColor = Math.max(0, colors.findIndex((c: string) => /red/i.test(c)));
    const blueColor = Math.max(0, colors.findIndex((c: string) => /blue/i.test(c)));
    const greenColor = Math.max(0, colors.findIndex((c: string) => /green/i.test(c)));
    const yellowColor = Math.max(0, colors.findIndex((c: string) => /yellow/i.test(c)));

    const humanPlayers: any[] = names.map((name, i) => ({
        name,
        countryId: i % 2 === 0 ? american : russian,
        colorId: [redColor, blueColor, greenColor, yellowColor][i % 4],
        startPos: i,
        teamId: teamOf(name),
    }));

    const gameOpts: any = {
        gameMode: 0,
        gameSpeed: 5,
        credits: 10000,
        unitCount: 1,
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
        mapName: 'alliance-test.map',
        mapTitle: 'Alliance Test',
        mapDigest: '',
        mapSizeBytes: 0,
        maxSlots: 4,
        mapOfficial: true,
        humanPlayers,
        aiPlayers: new Array(4).fill(undefined),
    };

    const gameModes: any = { getById: () => ({ type: 'Standard' }) };
    const game = GameFactory.create(
        buildMapFile(200),
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
    return game;
}

function makeGameFromOpts(mix: MixFile, gameOpts: any, modRulesName?: string): any {
    const baseRules = loadIniFromMix(mix, 'rules.ini');
    const baseArt = loadIniFromMix(mix, 'art.ini');
    const baseAi = loadIniFromMix(mix, 'ai.ini');
    if (modRulesName) {
        baseRules.mergeWith(loadIniFromMix(mix, modRulesName));
    } else {
        try {
            baseRules.mergeWith(loadIniFromMix(mix, 'MPBattle.ini'));
        } catch { /* noop */ }
    }
    patchYrGeneralKeys(baseRules);
    const gameModes: any = { getById: () => ({ type: 'Standard' }) };
    return GameFactory.create(
        buildMapFile(200),
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

describe('alliance formation from teamId (createInitialTeams)', () => {
    test('2v2: same-team players become allies, cross-team remain hostile', () => {
        const mix = loadMix();
        const names = ['A', 'B', 'C', 'D'];
        const game = makeGame(mix, names, (name) => (name === 'A' || name === 'B' ? 0 : 1));
        expect(game.rules.mpDialogSettings.alliesAllowed).toBe(true);
        game.init(game.getPlayerByName('A'));
        const get = (name: string) => game.getPlayerByName(name);
        const areAllied = (x: string, y: string) => game.alliances.areAllied(get(x), get(y));
        expect(areAllied('A', 'B')).toBe(true);
        expect(areAllied('C', 'D')).toBe(true);
        expect(areAllied('A', 'C')).toBe(false);
        expect(areAllied('B', 'D')).toBe(false);
        game.dispose?.();
    });

    test('all free-for-all (unique team per player) forms no alliances', () => {
        const mix = loadMix();
        const names = ['A', 'B', 'C', 'D'];
        const game = makeGame(mix, names, (name) => names.indexOf(name));
        game.init(game.getPlayerByName('A'));
        const get = (name: string) => game.getPlayerByName(name);
        const pairs: [string, string][] = [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D'], ['C', 'D']];
        for (const [x, y] of pairs) {
            expect(game.alliances.areAllied(get(x), get(y))).toBe(false);
        }
        game.dispose?.();
    });

    test('2v1 (3 combatants): two-man team allies, lone player hostile to both', () => {
        const mix = loadMix();
        const names = ['A', 'B', 'C'];
        const game = makeGame(mix, names, (name) => (name === 'A' || name === 'B' ? 0 : 1));
        const get = (name: string) => game.getPlayerByName(name);
        game.init(game.getPlayerByName('A'));
        expect(game.alliances.areAllied(get('A'), get('B'))).toBe(true);
        expect(game.alliances.areAllied(get('A'), get('C'))).toBe(false);
        expect(game.alliances.areAllied(get('B'), get('C'))).toBe(false);
        game.dispose?.();
    });

    test('human + AI on the same team: human allies with the allied AI', () => {
        const mix = loadMix();
        const gameOpts: any = {
            gameMode: 0,
            gameSpeed: 5,
            credits: 10000,
            unitCount: 1,
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
            mapName: 'alliance-test.map',
            mapTitle: 'Alliance Test',
            mapDigest: '',
            mapSizeBytes: 0,
            maxSlots: 4,
            mapOfficial: true,
            humanPlayers: [
                { name: 'A', countryId: 0, colorId: 0, startPos: 0, teamId: 0 },
                { name: 'B', countryId: 1, colorId: 1, startPos: 1, teamId: 1 },
            ],
            aiPlayers: [
                { difficulty: AiDifficulty.Normal, countryId: 0, colorId: 2, startPos: 2, teamId: 0 },
                undefined,
                undefined,
                undefined,
            ],
        };
        const game = makeGameFromOpts(mix, gameOpts);
        game.init(game.getPlayerByName('A'));
        const get = (name: string) => game.getPlayerByName(name);
        expect(game.alliances.areAllied(get('A'), get('@@AI1@@'))).toBe(true);
        expect(game.alliances.areAllied(get('A'), get('B'))).toBe(false);
        game.dispose?.();
    });

    test('quick-match 1v1 (server gameopts, teams 0/1 + lockAlliances): init OK, players hostile', () => {
        const mix = loadMix();
        const { Parser } = require('@/network/gameopt/Parser');
        const opts = new Parser().parseOptions(
            '0,0,2,10000,100,0,0,1,1,0,1,0,TGVnYWN5Lm1hcA==,2,1,1000,mpdefault,abc123,1,0,0,1,0,1:Alice,0,0,0,0,0,0,0,Bob,1,1,1,1,0,0,0:@:0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,',
        );
        expect(opts.lockAlliances).toBe(true);
        expect(opts.humanPlayers[0].teamId).toBe(0);
        expect(opts.humanPlayers[1].teamId).toBe(1);
        const game = makeGameFromOpts(mix, opts, 'mpbattle.ini');
        game.init(game.getPlayerByName('Alice'));
        const get = (name: string) => game.getPlayerByName(name);
        expect(game.alliances.areAllied(get('Alice'), get('Bob'))).toBe(false);
        game.dispose?.();
    });

    test('quick-match 2v2 (teams 0/1): allies form within sides', () => {
        const mix = loadMix();
        const { Parser } = require('@/network/gameopt/Parser');
        const opts = new Parser().parseOptions(
            '0,0,2,10000,100,0,0,1,1,0,1,0,TGVnYWN5Lm1hcA==,4,1,1000,mpdefault,abc123,1,0,0,1,0,1:Alice,0,0,0,0,0,0,0,Bob,1,1,1,0,0,0,0,Carol,2,2,2,1,0,0,0,Dave,3,3,3,1,0,0,0:@:0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,',
        );
        expect(opts.lockAlliances).toBe(true);
        const game = makeGameFromOpts(mix, opts, 'mpbattle.ini');
        game.init(game.getPlayerByName('Alice'));
        const get = (name: string) => game.getPlayerByName(name);
        expect(game.alliances.areAllied(get('Alice'), get('Bob'))).toBe(true);
        expect(game.alliances.areAllied(get('Carol'), get('Dave'))).toBe(true);
        expect(game.alliances.areAllied(get('Alice'), get('Carol'))).toBe(false);
        game.dispose?.();
    });

    test('lockAlliances: ToggleAllianceAction cannot form an alliance mid-game', () => {
        const mix = loadMix();
        const { Parser } = require('@/network/gameopt/Parser');
        const opts = new Parser().parseOptions(
            '0,0,2,10000,100,0,0,1,1,0,1,0,TGVnYWN5Lm1hcA==,4,1,1000,mpdefault,abc123,1,0,0,1,0,1:Alice,0,0,0,0,0,0,0,Bob,1,1,1,0,0,0,0,Carol,2,2,2,1,0,0,0,Dave,3,3,3,1,0,0,0:@:0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,',
        );
        const game = makeGameFromOpts(mix, opts, 'mpbattle.ini');
        game.init(game.getPlayerByName('Alice'));
        const { ToggleAllianceAction } = require('@/game/action/ToggleAllianceAction');
        const action = new ToggleAllianceAction(game);
        action.player = game.getPlayerByName('Alice');
        action.toPlayer = game.getPlayerByName('Carol');
        action.toggle = true;
        action.process();
        expect(game.alliances.areAllied(game.getPlayerByName('Alice'), game.getPlayerByName('Carol'))).toBe(false);
        game.dispose?.();
    });

    test('lockAlliances survives Serializer/Parser round-trip', () => {
        const { Parser } = require('@/network/gameopt/Parser');
        const { Serializer } = require('@/network/gameopt/Serializer');
        const gameOpts: any = {
            gameMode: 1,
            gameSpeed: 4,
            credits: 10000,
            unitCount: 100,
            shortGame: false,
            superWeapons: false,
            buildOffAlly: true,
            mcvRepacks: true,
            cratesAppear: false,
            hostTeams: false,
            destroyableBridges: true,
            multiEngineer: false,
            noDogEngiKills: false,
            instantCapture: true,
            delayedOils: false,
            lockAlliances: true,
            mapName: 'mpdefault',
            mapTitle: 'Legacy.map',
            mapDigest: 'abc123',
            mapSizeBytes: 1000,
            maxSlots: 2,
            mapOfficial: true,
            humanPlayers: [
                { name: 'Alice', countryId: 0, colorId: 0, startPos: 0, teamId: 0 },
                { name: 'Bob', countryId: 1, colorId: 1, startPos: 1, teamId: 1 },
            ],
            aiPlayers: new Array(8).fill(undefined),
        };
        const serialized = new Serializer().serializeOptions(gameOpts);
        const reparsed = new Parser().parseOptions(serialized);
        expect(reparsed.lockAlliances).toBe(true);
        expect(reparsed.humanPlayers[0].teamId).toBe(0);
        expect(reparsed.humanPlayers[1].teamId).toBe(1);
    });
});
