import { describe, expect, test } from 'bun:test';
import { ReplayTurnManager } from '@/network/gamestate/ReplayTurnManager';
import { Replay } from '@/network/gamestate/Replay';
import { TurnActionsReplayEvent } from '@/network/gamestate/replay/TurnActionsReplayEvent';
import { Serializer } from '@/network/gameopt/Serializer';
import { Parser } from '@/network/gameopt/Parser';

const STATUS_STARTED = 1;
const STATUS_ENDED = 2;

class FakeGame {
    status = STATUS_STARTED;
    currentTick = 0;
    speed = { value: 30 };
    desiredSpeed = {
        value: 30,
        onChange: { subscribe: () => { }, unsubscribe: () => { } },
    };
    constructor(private readonly onTick?: () => void) { }
    update(): void {
        this.currentTick += 1;
        this.onTick?.();
    }
    getPlayer(): any {
        return { name: 'P1' };
    }
}

function makeReplay(events: any[], endTick: number): any {
    const replay = new Replay();
    replay.writeEvent(...events);
    replay.finish(endTick);
    return replay;
}

function makeActionEvent(tickNo: number): TurnActionsReplayEvent {
    const event = new TurnActionsReplayEvent(new Parser(), new Serializer(), tickNo);
    event.payload = [[0, [{ id: 0, params: new Uint8Array() }]]];
    return event;
}

function makeManager(game: FakeGame, replay: any, processedTicks: number[] = []): { manager: ReplayTurnManager; dispatched: any[] } {
    const actionFactory = {
        create: (id: number) => ({
            id,
            player: undefined,
            unserialize: () => { },
            process: () => { },
            print: () => 'noop',
        }),
    };
    const manager = new ReplayTurnManager(game, replay, actionFactory);
    const dispatched: any[] = [];
    manager.onReplayEvent.subscribe((event: any) => dispatched.push(event));
    manager.init();
    const originalProcessActions = manager.processActions.bind(manager);
    manager.processActions = ((actions: Array<[number, any[]]>) => {
        originalProcessActions(actions);
        processedTicks.push(game.currentTick);
    }) as any;
    return { manager, dispatched };
}

describe('ReplayTurnManager seekTo', () => {
    test('fast-forwards the game to the target tick and skips event dispatch for the skipped span', () => {
        const game = new FakeGame();
        const earlyEvent = makeActionEvent(10);
        const lateEvent = makeActionEvent(25);
        const replay = makeReplay([earlyEvent, lateEvent], 40);
        const processedTicks: number[] = [];
        const { manager, dispatched } = makeManager(game, replay, processedTicks);

        manager.seekTo(20);

        expect(game.currentTick).toBe(20);
        expect(processedTicks).toEqual([10]);
        expect(dispatched).toHaveLength(0);

        for (let i = 0; i < 6; i++) {
            manager.doGameTurn(0);
        }
        expect(dispatched).toEqual([lateEvent]);
        expect(game.currentTick).toBe(26);
    });

    test('clamps the target to the replay end tick', () => {
        const game = new FakeGame();
        const replay = makeReplay([], 40);
        const { manager } = makeManager(game, replay);

        manager.seekTo(999);

        expect(game.currentTick).toBe(40);
        expect(manager.isFinished()).toBe(false);
    });

    test('stops fast-forwarding when the game ends mid-seek', () => {
        const game = new FakeGame(() => {
            if (game.currentTick >= 5) {
                game.status = STATUS_ENDED;
            }
        });
        const replay = makeReplay([], 40);
        const { manager } = makeManager(game, replay);

        manager.seekTo(40);

        expect(game.currentTick).toBe(5);
    });

    test('reports progress while seeking and 100% when done', () => {
        const game = new FakeGame();
        const replay = makeReplay([], 1000);
        const { manager } = makeManager(game, replay);
        const progress: number[] = [];

        manager.seekTo(1000, (percent) => progress.push(percent));

        expect(game.currentTick).toBe(1000);
        expect(progress.length).toBeGreaterThan(1);
        expect(progress[progress.length - 1]).toBe(1);
    });
});
