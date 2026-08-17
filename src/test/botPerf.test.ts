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
import { AiDifficulty } from '@/game/gameopts/GameOpts';
import { BoxedVar } from '@/util/BoxedVar';

const TICK_BUDGET_MS = 1000 / 15;

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

type Scenario = {
    label: string;
    humans: number;
    bots: number;
};

const SCENARIOS: Scenario[] = [
    { label: '2h+0b (baseline)', humans: 2, bots: 0 },
    { label: '2h+1b', humans: 2, bots: 1 },
    { label: '2h+2b', humans: 2, bots: 2 },
    { label: '4h+0b (player-count control)', humans: 4, bots: 0 },
];

interface PerfSample {
    label: string;
    totalMs: number[];
    botMs: number[];
    heavyTickMs: number[];
    heavyTicks: number;
    ticksSimulated: number;
}

function percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

function summarize(values: number[]): string {
    if (!values.length) return 'n=0';
    const sorted = [...values].sort((a, b) => a - b);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return `avg=${avg.toFixed(2)}ms p50=${percentile(sorted, 50).toFixed(2)}ms p95=${percentile(sorted, 95).toFixed(2)}ms max=${sorted[sorted.length - 1].toFixed(2)}ms (n=${values.length})`;
}

function makeGame(mix: MixFile, scenario: Scenario) {
    const baseRules = loadIniFromMix(mix, 'rules.ini');
    const baseArt = loadIniFromMix(mix, 'art.ini');
    const baseAi = loadIniFromMix(mix, 'ai.ini');
    try {
        baseRules.mergeWith(loadIniFromMix(mix, 'MPBattle.ini'));
    } catch { /* noop */ }
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

    const humanPlayers: any[] = [];
    for (let i = 0; i < scenario.humans; i++) {
        humanPlayers.push({
            name: `Human${i + 1}`,
            countryId: i % 2 === 0 ? american : russian,
            colorId: [redColor, blueColor, greenColor, yellowColor][i % 4],
            startPos: i,
            teamId: i % 2,
        });
    }
    const aiPlayers: any[] = new Array(4).fill(undefined);
    for (let i = 0; i < scenario.bots; i++) {
        aiPlayers[i] = {
            difficulty: AiDifficulty.Normal,
            countryId: i % 2 === 0 ? american : russian,
            colorId: [redColor, blueColor, greenColor, yellowColor][(i + 2) % 4],
            startPos: i + scenario.humans,
            teamId: (i + scenario.humans) % 2,
        };
    }

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
        mapName: 'perf-test.map',
        mapTitle: 'Perf Test',
        mapDigest: '',
        mapSizeBytes: 0,
        maxSlots: 4,
        mapOfficial: true,
        humanPlayers,
        aiPlayers,
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

function safeUpdate(game: any): void {
    try {
        game.update();
    } catch { /* keep going */ }
}

function runScenario(mix: MixFile, scenario: Scenario): PerfSample {
    const game = makeGame(mix, scenario);
    game.init(undefined);
    seedArmies(game);
    game.start();

    const totalMs: number[] = [];
    const botMs: number[] = [];
    const heavyTickMs: number[] = [];
    let heavyTicks = 0;
    const botManager = game.botManager;
    const origBotUpdate = botManager.update.bind(botManager);

    instrumentInnerBots(game);

    const WARMUP_TICKS = 1500;
    const MEASURE_TICKS = 3000;

    for (let tick = 0; tick < WARMUP_TICKS; tick++) {
        safeUpdate(game);
    }
    game.botManager.update = (state: any) => {
        const t0 = performance.now();
        origBotUpdate(state);
        botMs.push(performance.now() - t0);
    };
    let updateErrors = 0;
    for (let tick = 0; tick < MEASURE_TICKS; tick++) {
        const t0 = performance.now();
        try {
            game.update();
        } catch (e) {
            updateErrors++;
            if (updateErrors <= 5) {
                console.log(`[BotPerf:update-error] ${String((e as Error)?.message ?? e).slice(0, 120)}`);
            }
        }
        const elapsed = performance.now() - t0;
        totalMs.push(elapsed);
        if (elapsed > 5) {
            heavyTickMs.push(elapsed);
            heavyTicks++;
        }
    }
    const spikeLedger = game.__spikeLedger as { tick: number; section: string; ms: number }[];
    if (spikeLedger?.length) {
        const byTick = new Map<number, Map<string, number>>();
        for (const entry of spikeLedger) {
            const sections = byTick.get(entry.tick) ?? new Map<string, number>();
            sections.set(entry.section, (sections.get(entry.section) ?? 0) + entry.ms);
            byTick.set(entry.tick, sections);
        }
        const topTicks = [...byTick.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0)).slice(0, 8);
        for (const [tick, sections] of topTicks) {
            const total = [...sections.values()].reduce((x, y) => x + y, 0);
            console.log(`[BotPerf:spike-tick] ${scenario.label} tick=${tick} instrumented=${total.toFixed(1)}ms | ${[...sections.entries()].map(([s, m]) => `${s}=${m.toFixed(1)}`).join(' ')}`);
        }
    }
    console.log(`[BotPerf] ${scenario.label} update errors: ${updateErrors}`);
    game.botManager.dispose();
    game.dispose?.();
    return {
        label: scenario.label,
        totalMs,
        botMs,
        heavyTickMs,
        heavyTicks,
        ticksSimulated: WARMUP_TICKS + MEASURE_TICKS,
    };
}

function instrumentInnerBots(game: any): void {
    const spikeLedger: { tick: number; section: string; ms: number }[] = [];
    const currentTickOf = (innerBot: any) => innerBot.gameApi?.getCurrentTick?.() ?? -1;
    const terrain = game.map.terrain;
    if (terrain && !terrain.__instrumented) {
        const origComputePath = terrain.computePath.bind(terrain);
        terrain.computePath = (...args: any[]) => {
            const t0 = performance.now();
            const result = origComputePath(...args);
            const elapsed = performance.now() - t0;
            if (true) {
                spikeLedger.push({ tick: game.currentTick, section: 'pathfind', ms: elapsed });
            }
            return result;
        };
        terrain.__instrumented = true;
    }
    const gameApi = (game.botManager as any).gameApi;
    if (gameApi && !gameApi.__instrumented) {
        const origGetVisible = gameApi.getVisibleUnits.bind(gameApi);
        gameApi.getVisibleUnits = (playerName: string, type: string, filter?: any) => {
            const t0 = performance.now();
            const result = origGetVisible(playerName, type, filter);
            const elapsed = performance.now() - t0;
            if (true) {
                spikeLedger.push({ tick: game.currentTick, section: `vis:${type}`, ms: elapsed });
            }
            return result;
        };
        gameApi.__instrumented = true;
    }
    game.__spikeLedger = spikeLedger;
    for (const bot of game.botManager.bots.values()) {
        const innerBot = (bot as any).innerBot ?? bot;
        if (!innerBot?.matchAwareness) continue;
        const awareness = innerBot.matchAwareness;
        if (awareness.onAiUpdate.__instrumented) continue;
        const origAwareness = awareness.onAiUpdate.bind(awareness);
        awareness.onAiUpdate = (ctx: any) => {
            const t0 = performance.now();
            origAwareness(ctx);
            const elapsed = performance.now() - t0;
            if (true) {
                const buildSpace = awareness.getBuildSpaceCache?.();
                const findSpaceT0 = performance.now();
                buildSpace?.findSpace(9);
                const findSpaceElapsed = performance.now() - findSpaceT0;
                if (findSpaceElapsed > 5) {
                    spikeLedger.push({ tick: currentTickOf(innerBot), section: `findSpace:${innerBot.name}`, ms: findSpaceElapsed });
                }
                const cellCount = (buildSpace?._cache as any)?.getSize?.();
                if (findSpaceElapsed > 5) {
                    console.log(`[BotPerf:findSpace] ${innerBot.name} tick=${currentTickOf(innerBot)} ${findSpaceElapsed.toFixed(1)}ms (map ${cellCount?.width ?? '?'}x${cellCount?.height ?? '?'})`);
                }
            }
        };
        awareness.onAiUpdate.__instrumented = true;
        const missions = innerBot.missionController;
        if (missions && !missions.onAiUpdate.__instrumented) {
            const origMissions = missions.onAiUpdate.bind(missions);
            missions.onAiUpdate = (ctx: any) => {
                const t0 = performance.now();
                origMissions(ctx);
                const elapsed = performance.now() - t0;
                if (true) {
                    spikeLedger.push({ tick: currentTickOf(innerBot), section: `missions:${innerBot.name}`, ms: elapsed });
                }
            };
            missions.onAiUpdate.__instrumented = true;
        }
        const queue = innerBot.queueController;
        if (queue && !queue.onAiUpdate.__instrumented) {
            const origQueue = queue.onAiUpdate.bind(queue);
            queue.onAiUpdate = (ctx: any, threatCache: any, requests: any, log: any) => {
                const t0 = performance.now();
                origQueue(ctx, threatCache, requests, log);
                const elapsed = performance.now() - t0;
                if (true) {
                    spikeLedger.push({ tick: currentTickOf(innerBot), section: `queue:${innerBot.name}`, ms: elapsed });
                }
            };
            queue.onAiUpdate.__instrumented = true;
        }
    }
}

function seedArmies(game: any): void {
    const objectFactory = game.objectFactory;
    const mapSize = game.map.mapBounds.getFullSize();
    const size = Math.min(mapSize.width, mapSize.height) / 2 - 2;
    const combatants = game.getCombatants();
    const rules = game.rules;
    const art = game.art;
    const vehicleNames = [...rules.vehicleRules.keys()].filter((name: string) =>
        art.hasObject(name, ObjectType.Vehicle) && !rules.getObject(name, ObjectType.Vehicle)?.harvester,
    );
    const infantryNames = [...rules.infantryRules.keys()].filter((name: string) =>
        art.hasObject(name, ObjectType.Infantry),
    );
    const buildingNames = [...rules.buildingRules.keys()].filter((name: string) =>
        art.hasObject(name, ObjectType.Building) && !rules.getObject(name, ObjectType.Building)?.wall,
    );
    const UNIT_COUNT = 400;
    const BUILDING_COUNT = 30;
    let placed = 0;
    const startLocations = game.map.startingLocations as { x: number; y: number }[];
    for (const player of combatants) {
        const start = startLocations[player.startLocation ?? 0] ?? { x: 30, y: 30 };
        const playerUnits: any[] = [];
        for (let i = 0; i < UNIT_COUNT; i++) {
            const name = vehicleNames.length > 0 && i % 3 !== 0
                ? vehicleNames[i % vehicleNames.length]
                : infantryNames[i % Math.max(1, infantryNames.length)];
            try {
                const obj = objectFactory.create(ObjectType.Vehicle, name, rules, art);
                game.changeObjectOwner(obj, player);
                const rx = Math.min(size - 2, Math.max(2, start.x + (i % 12) - 6));
                const ry = Math.min(size - 2, Math.max(2, start.y + Math.floor(i / 12) - 3));
                const tile = game.map.tiles.getByMapCoords(rx, ry);
                if (tile) {
                    game.spawnObject(obj, tile);
                    playerUnits.push(obj);
                    placed++;
                }
            } catch { /* skip unplaceable unit types */ }
        }
        for (let i = 0; i < BUILDING_COUNT; i++) {
            const name = buildingNames[i % buildingNames.length];
            try {
                const obj = objectFactory.create(ObjectType.Building, name, rules, art);
                game.changeObjectOwner(obj, player);
                const rx = Math.min(size - 6, Math.max(6, start.x + (i % 5) * 3 - 6));
                const ry = Math.min(size - 6, Math.max(6, start.y + Math.floor(i / 5) * 3 - 3));
                const tile = game.map.tiles.getByMapCoords(rx, ry);
                if (tile) {
                    game.spawnObject(obj, tile);
                    placed++;
                }
            } catch { /* skip */ }
        }
    }
    console.log(`[BotPerf] seeded ${placed} objects across ${combatants.length} players`);
}

describe('bot AI per-tick CPU cost scaling (headless, real rules, synthetic 200x200 map)', () => {
    test('measures per-tick cost for 0/1/2 bots', () => {
        const mix = loadMix();
        const samples = SCENARIOS.map((s) => runScenario(mix, s));
        for (const sample of samples) {
            console.log(`[BotPerf] ${sample.label}: total tick ${summarize(sample.totalMs)} | botManager ${summarize(sample.botMs)} | heavy(>5ms) ticks=${sample.heavyTicks} ${summarize(sample.heavyTickMs)}`);
        }
        const byLabel = new Map(samples.map((s) => [s.label, s]));
        const baseline = byLabel.get('2h+0b (baseline)')!;
        const oneBot = byLabel.get('2h+1b')!;
        const twoBot = byLabel.get('2h+2b')!;
        const fourHuman = byLabel.get('4h+0b (player-count control)')!;
        const med = (s: PerfSample) => percentile([...s.totalMs].sort((a, b) => a - b), 50);
        const botMed = (s: PerfSample) => percentile([...s.botMs].sort((a, b) => a - b), 50);
        console.log(`[BotPerf] bot-only median: baseline=${botMed(baseline).toFixed(2)}ms 1bot=${botMed(oneBot).toFixed(2)}ms 2bot=${botMed(twoBot).toFixed(2)}ms 4h=${botMed(fourHuman).toFixed(2)}ms`);
        expect(med(twoBot)).toBeGreaterThan(med(baseline));
        expect(botMed(twoBot)).toBeGreaterThan(botMed(oneBot));
    });
});
