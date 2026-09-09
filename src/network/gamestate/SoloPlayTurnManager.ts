import { NoAction } from '@/game/action/NoAction';
import { GameStatus } from '@/game/Game';
import { GameSpeed } from '@/game/GameSpeed';
import { EventDispatcher } from '@/util/event';
import type { Game } from '@/game/Game';
import type { Player } from '@/game/Player';
import type { Action } from '@/game/action/Action';
import type { RecordedActions } from '@/network/gamestate/ReplayRecorder';
import type { ProcessableAction } from '@/network/gamestate/PlayerActionPayload';

export class SoloPlayTurnManager {
    private gameTurnMillis = 1000 / GameSpeed.BASE_TICKS_PER_SECOND;
    private errorState = false;
    private gameSpeedChanged = false;
    public readonly onActionsSent = new EventDispatcher<this, void>();

    private readonly onGameSpeedChanged = () => {
        this.gameSpeedChanged = true;
    };

    constructor(
        private readonly game: Game,
        private readonly currentPlayer: Player,
        private readonly inputActions: { dequeueAll(): Action[] },
        private readonly actionLogger?: { debug(message: string): void },
        private readonly replayRecorder?: { recordActions?(tick: number, actions: RecordedActions): void }
    ) { }

    init(): void {
        this.game.desiredSpeed.onChange.subscribe(this.onGameSpeedChanged);
        this.computeGameTurn(this.game.speed.value);
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

    doGameTurn(_timestamp: number): boolean {
        if (this.errorState) {
            return false;
        }

        if (this.game.status !== GameStatus.Ended) {
            let actions = this.inputActions.dequeueAll();
            if (actions.length) {
                this.replayRecorder?.recordActions?.(this.game.currentTick, actions);
                this.onActionsSent.dispatch(this);
            } else {
                actions = [new NoAction()];
            }
            this.processActions(actions);
        }

        this.game.update();

        if (this.gameSpeedChanged) {
            this.game.speed.value = this.game.desiredSpeed.value;
            this.computeGameTurn(this.game.speed.value);
            this.gameSpeedChanged = false;
        }

        return true;
    }

    private processActions(actions: Action[]): void {
        actions.forEach((action) => {
            const processable = action as unknown as ProcessableAction;
            processable.player = this.currentPlayer;
            processable.process();
            const printable = action.print?.();
            if (printable) {
                this.actionLogger?.debug(`(${action.player.name})@${this.game.currentTick}: ${printable}`);
            }
        });
    }

    dispose(): void {
        this.game.desiredSpeed.onChange.unsubscribe(this.onGameSpeedChanged);
    }
}
