import { TurnActionsReplayEvent } from '@/network/gamestate/replay/TurnActionsReplayEvent';
import { GameStatus } from '@/game/Game';
import { GameSpeed } from '@/game/GameSpeed';
import { EventDispatcher } from '@/util/event';

export class ReplayTurnManager {
    private gameTurnMillis = 1000 / GameSpeed.BASE_TICKS_PER_SECOND;
    private errorState = false;
    private gameSpeedChanged = false;
    private finished = false;
    private replayIterator: IterableIterator<any>;
    private nextReplayEvent: any;

    private readonly _onReplayEvent = new EventDispatcher<this, any>();
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
        private readonly game: any,
        private readonly replay: any,
        private readonly actionFactory: any,
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
            while (this.nextReplayEvent && this.nextReplayEvent.tickNo === this.game.currentTick) {
                if (this.nextReplayEvent instanceof TurnActionsReplayEvent) {
                    this.processActions(this.nextReplayEvent.payload);
                    this._onActionsSent.dispatch(this);
                }
                this._onReplayEvent.dispatch(this, this.nextReplayEvent);
                this.nextReplayEvent = this.replayIterator.next().value;
            }
            if (this.nextReplayEvent && this.nextReplayEvent.tickNo < this.game.currentTick) {
                throw new Error('Replay event desync');
            }
            if (this.replay.endTick + 1 <= this.game.currentTick) {
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

    processActions(actions: Array<[number, any[]]>): void {
        actions.forEach(([playerId, playerActions]) => {
            playerActions.forEach((action) => {
                const createdAction = this.actionFactory.create(action.id);
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
