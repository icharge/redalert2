import { describe, expect, test } from 'bun:test';
import { Replay } from '@/network/gamestate/Replay';
import { TurnActionsReplayEvent } from '@/network/gamestate/replay/TurnActionsReplayEvent';
import { ReplayEventType } from '@/network/gamestate/replay/ReplayEventType';

// A replay file in the exact format written by the server-side recorder
// (server/src/gserv/replay/GservReplayRecorder.ts): header + "tick=type|payload"
// event lines + END tag. Proves the client can load server-produced replays.
// The turn-actions payload below was produced by the server's own codec
// (serializeAllPlayerActions) and hardcoded so this test is a genuine
// cross-implementation contract check.
function buildServerReplayText(): string {
    const gameopts = '0,0,0,10000,50,0,0,0,1,0,0,0,SXNsYW5kIFdhcg==,8,1,100,mpdefault,abc,1,0,0,1,0:' +
        'alice,1,1,1,1,0,0,0,bob,1,2,2,1,0,0,0:@:,-1,-1,-1,-1,';
    return [
        'RA2TSREPL_v6',
        'ENGINE 0.83 0',
        `g1-abc 1730000000 ${gameopts}`,
        '4=0|AgAHAAEFAwABAgMBBAABAAAA',
        '4=1|0:AGMAYQB0AHM=',
        'END 4',
    ].join('\n') + '\n';
}

describe('server-produced replay loadability', () => {
    test('Replay.unserialize parses a server-format .rpl', () => {
        const replay = new Replay();
        replay.unserialize(buildServerReplayText(), { name: 'test', timestamp: 1 });
        expect(replay.gameId).toBe('g1-abc');
        expect(replay.gameTimestamp).toBe(1730000000);
        expect(replay.engineVersion).toBe('0.83');
        expect(replay.modHash).toBe('0');
        expect(replay.finishedTick).toBe(4);
        expect(replay.getEvents().length).toBe(2);

        const turnActions = replay.getEvents().find(event => event.type === ReplayEventType.TurnActions);
        expect(turnActions).toBeInstanceOf(TurnActionsReplayEvent);
        expect(turnActions.tickNo).toBe(4);
        expect(turnActions.payload).toEqual([
            [0, [{ id: 5, params: new Uint8Array([1, 2, 3]) }]],
            [1, [{ id: 0, params: new Uint8Array() }]],
        ]);

        const chat = replay.getEvents().find(event => event.type === ReplayEventType.ChatMessage);
        expect(chat.payload).toEqual({ playerId: 0, message: 'cats' });
    });
});
