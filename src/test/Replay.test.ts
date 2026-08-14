import { describe, it, expect } from 'bun:test';
import { Replay } from '@/network/gamestate/Replay';
import { Serializer } from '@/network/gameopt/Serializer';
import { Parser } from '@/network/gameopt/Parser';
import { TurnActionsReplayEvent } from '@/network/gamestate/replay/TurnActionsReplayEvent';

function makeGameOpts() {
    return {
        gameMode: 0,
        gameSpeed: 6,
        credits: 10000,
        unitCount: 1,
        shortGame: false,
        superWeapons: true,
        buildOffAlly: false,
        mcvRepacks: false,
        cratesAppear: true,
        hostTeams: false,
        mapTitle: 'Test Map',
        maxSlots: 4,
        mapOfficial: false,
        mapSizeBytes: 12345,
        mapName: 'test.map',
        mapDigest: 'abc123',
        destroyableBridges: true,
        multiEngineer: false,
        noDogEngiKills: false,
        instantCapture: false,
        delayedOils: true,
        humanPlayers: [{ name: 'P1', countryId: 0, colorId: 0, startPos: 0, teamId: 0 }],
        aiPlayers: [undefined, undefined, undefined],
    };
}

describe('Replay text format', () => {
    it('serializes and round-trips to upstream RA2TSREPL_v6', () => {
        const serializer = new Serializer();
        const parser = new Parser();

        const replay = new Replay();
        replay.init('game-1', 1700000000, makeGameOpts(), '0.83', '123');
        replay.name = 'Test';

        const ta = new TurnActionsReplayEvent(parser, serializer, 10);
        ta.payload = [[0, [{ id: 0, params: new Uint8Array([1, 2, 3]) }]]];
        replay.writeEvent(ta);
        replay.finish(20);

        const text = replay.serialize();
        expect(text.startsWith('RA2TSREPL_v6')).toBe(true);
        expect(text).toContain('ENGINE 0.83 123');

        const replay2 = new Replay();
        replay2.unserialize(text, { name: 'Test', timestamp: 1 });
        expect(replay2.gameId).toBe('game-1');
        expect(replay2.endTick).toBe(20);
        expect(replay2.events.length).toBe(1);
        expect(replay2.events[0].type).toBe(0); // TurnActions
    });

    it('parses header', async () => {
        const replay = new Replay();
        replay.init('game-2', 1700000001, makeGameOpts(), '0.83', '456');
        replay.finish(5);
        const text = replay.serialize();
        const header = await new Replay().parseHeader(text);
        expect(header.gameId).toBe('game-2');
        expect(header.engineVersion).toBe('0.83');
    });
});
