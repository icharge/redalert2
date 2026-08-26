import { TurnActionsReplayEvent } from '@/network/gamestate/replay/TurnActionsReplayEvent';
import { GameStatus } from '@/game/Game';
import { GameSpeed } from '@/game/GameSpeed';
import { EventDispatcher } from '@/util/event';
import type { Game } from '@/game/Game';
import type { Replay } from '@/network/gamestate/Replay';
import type { ReplayEvent } from '@/network/gamestate/replay/ReplayEvent';
import type { ActionFactory } from '@/game/action/ActionFactory';
import type { ActionType } from '@/game/action/ActionType';
import type { PlayerActionPayload } from '@/network/gamestate/PlayerActionPayload';

export class ReplayTurnManager {
    private gameTurnMillis = 1000 / GameSpeed.BASE_TICKS_PER_SECOND;
    private errorState = false;
    private gameSpeedChanged = false;
    private finished = false;
    private replayIterator: IterableIterator<ReplayEvent>;
    private nextReplayEvent: ReplayEvent | undefined;

    private readonly _onReplayEvent = new EventDispatcher<this, ReplayEvent>();
    private readonly _onActionsSent = new EventDispatcher<this, void>();
    private readonly _onFinished = new EventDispatcher<this, void>();

    public get onReplayEvent() {
        return this._onReplayEvent.asEvent();
    }
    public readonly onActionsSent = this._onActionsSent.asEvent();
    public readonly onFinished = this._onFinished.asEvent();

    private readonly onGameSpeedChanged = () => {
        this.gameSpeedChanged = true;
    };

    constructor(
        private readonly game: Game,
        private readonly replay: Replay,
        private readonly actionFactory: ActionFactory,
        private readonly actionLogger?: { debug(message: string): void },
    ) {}

    init(): void {
        this.game.desiredSpeed.onChange.subscribe(this.onGameSpeedChanged);
        this.computeGameTurn(this.game.speed.value);
        this.replayIterator = this.replay.getEvents().values();
        this.nextReplayEvent = this.replayIterator.next().value;
    }

    private computeGameTurn(speed: number): void {
        this.gameTurnMillis = 1000 / (speed * GameSpeed.BASE_TICKS_PER_SECOND);
    }

    setErrorState(): void {
        this.errorState = true;
    }

    getErrorState(): boolean {
        return this.errorState;
    }

    getTurnMillis(): number {
        return this.gameTurnMillis;
    }

    isFinished(): boolean {
        return this.finished;
    }

    doGameTurn(_timestamp: number): boolean {
        if (this.errorState) {
            return false;
        }
        if (this.game.status !== GameStatus.Ended) {
            this.processEventsForCurrentTick(true);
            if (this.nextReplayEvent && this.nextReplayEvent.tickNo < this.game.currentTick) {
                throw new Error('Replay event desync');
            }
            if (this.replay.endTick! + 1 <= this.game.currentTick) {
                this.finished = true;
                this.game.status = GameStatus.Ended;
                this._onFinished.dispatch(this, undefined);
                return false;
            }
            else {
                this.game.update();
                if (this.gameSpeedChanged) {
                    this.game.speed.value = this.game.desiredSpeed.value;
                    this.computeGameTurn(this.game.speed.value);
                    this.gameSpeedChanged = false;
                }
            }
        }
        else {
            this.game.speed.value = 0;
        }
        return true;
    }

    seekTo(targetTick: number, onProgress?: (percent: number) => void): void {
        if (this.errorState) {
            return;
        }
        this.finished = false;
        const target = Math.min(targetTick, this.replay.endTick!);
        let lastReportedTick = 0;
        while (this.game.currentTick < target && this.game.status !== GameStatus.Ended) {
            this.processEventsForCurrentTick(false);
            if (this.nextReplayEvent && this.nextReplayEvent.tickNo < this.game.currentTick) {
                throw new Error('Replay event desync');
            }
            this.game.update();
            if (onProgress && this.game.currentTick - lastReportedTick >= 300) {
                lastReportedTick = this.game.currentTick;
                onProgress(target > 0 ? this.game.currentTick / target : 1);
            }
        }
        if (onProgress) {
            onProgress(1);
        }
    }

    private processEventsForCurrentTick(dispatch: boolean): void {
        while (this.nextReplayEvent && this.nextReplayEvent.tickNo === this.game.currentTick) {
            if (this.nextReplayEvent instanceof TurnActionsReplayEvent) {
                this.processActions(this.nextReplayEvent.payload);
                if (dispatch) {
                    this._onActionsSent.dispatch(this);
                }
            }
            if (dispatch) {
                this._onReplayEvent.dispatch(this, this.nextReplayEvent);
            }
            this.nextReplayEvent = this.replayIterator.next().value;
        }
    }

    processActions(actions: Array<[number, Array<PlayerActionPayload>]>): void {
        actions.forEach(([playerId, playerActions]) => {
            playerActions.forEach((action) => {
                const createdAction = this.actionFactory.create(action.id as ActionType);
                createdAction.player = this.game.getPlayer(playerId);
                createdAction.unserialize(action.params);
                createdAction.process();
                const printable = createdAction.print?.();
                if (printable) {
                    this.actionLogger?.debug(`(${createdAction.player.name})@${this.game.currentTick}: ` + printable);
                }
            });
        });
    }

    dispose(): void {
        this.game.desiredSpeed.onChange.unsubscribe(this.onGameSpeedChanged);
    }
}
