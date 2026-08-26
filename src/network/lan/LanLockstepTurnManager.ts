import { GameStatus } from '@/game/Game';
import { GameSpeed } from '@/game/GameSpeed';
import { ActionType } from '@/game/action/ActionType';
import { NoAction } from '@/game/action/NoAction';
import { Parser } from '@/network/gameopt/Parser';
import { Serializer } from '@/network/gameopt/Serializer';
import { TURN_TIMEOUT_MILLIS } from '@/network/gservConfig';
import { LanMatchSession, LanResolvedTurn } from '@/network/lan/LanMatchSession';
import { EventDispatcher } from '@/util/event';
import type { Game } from '@/game/Game';
import type { Player } from '@/game/Player';
import type { Action } from '@/game/action/Action';
import type { ActionFactory } from '@/game/action/ActionFactory';
import type { ProcessableAction } from '@/network/gamestate/PlayerActionPayload';
import type { RecordedActions } from '@/network/gamestate/ReplayRecorder';

export class LanLockstepTurnManager {
    private readonly serializer = new Serializer();
    private readonly parser = new Parser();
    private readonly submittedTicks = new Set<number>();
    private gameTurnMillis = 1000 / GameSpeed.BASE_TICKS_PER_SECOND;
    private errorState = false;
    private passiveMode = false;
    private lagState = false;
    private matchDisposed = false;
    private stalledSince?: number;

    public readonly onActionsSent = new EventDispatcher<this, string>();
    public readonly onActionsReceived = new EventDispatcher<this, string>();
    public readonly onLagStateChange = new EventDispatcher<this, boolean>();

    constructor(
        private readonly game: Game,
        private readonly localPlayer: Player,
        private readonly inputActions: { dequeueAll(): Action[] },
        private readonly actionFactory: ActionFactory,
        private readonly matchSession: LanMatchSession,
        private readonly actionLogger?: { debug(message: string): void },
        private readonly lockstepLogger?: { debug?(message: string): void; warn?(message: string): void },
        private readonly replayRecorder?: { recordActions?(tick: number, actions: RecordedActions): void }
    ) { }

    init(): void {
        this.computeGameTurn(this.game.speed.value);
        this.matchSession.onActionsReceived.subscribe(this.handleActionsReceived);
    }

    getTurnMillis(): number {
        return this.gameTurnMillis;
    }

    setPassiveMode(passive: boolean): void {
        this.passiveMode = passive;
    }

    setErrorState(): void {
        this.errorState = true;
    }

    getErrorState(): boolean {
        return this.errorState;
    }

    doGameTurn(_timestamp: number): boolean {
        if (this.errorState) {
            return false;
        }

        const tick = this.game.currentTick;
        if (this.game.status !== GameStatus.Ended) {
            const localTurnId = this.submitLocalTurn(tick);
            if (localTurnId) {
                this.onActionsSent.dispatch(this, localTurnId);
            }

            const resolvedTurn = this.matchSession.tryConsumeTurn(tick);
            if (!resolvedTurn) {
                this.updateLagState(true, tick);
                const now = Date.now();
                if (this.stalledSince === undefined) {
                    this.stalledSince = now;
                }
                else if (now - this.stalledSince > TURN_TIMEOUT_MILLIS) {
                    this.matchSession.notifyStalledTurn(tick);
                    this.stalledSince = now;
                }
                return false;
            }

            this.stalledSince = undefined;
            this.updateLagState(false, tick);
            const processedActions = this.processResolvedTurn(tick, resolvedTurn);
            if (processedActions.length) {
                this.replayRecorder?.recordActions?.(tick, processedActions);
            }
            if (tick > 0 && tick % 300 === 0) {
                this.lockstepLogger?.debug?.(`[lan] tick=${tick} hash=${this.game.getHash()} peers=${resolvedTurn.batches.map((batch) => batch.peerId).join(',')}`);
            }
        }

        this.game.update();
        return true;
    }

    dispose(): void {
        this.matchSession.onActionsReceived.unsubscribe(this.handleActionsReceived);
        if (!this.matchDisposed) {
            this.matchSession.dispose();
            this.matchDisposed = true;
        }
    }

    private readonly handleActionsReceived = (turnId: string) => {
        this.onActionsReceived.dispatch(this, turnId);
    };

    private computeGameTurn(speed: number): void {
        this.gameTurnMillis = 1000 / (speed * GameSpeed.BASE_TICKS_PER_SECOND);
    }

    private submitLocalTurn(tick: number): string | undefined {
        if (this.submittedTicks.has(tick)) {
            return undefined;
        }
        let actions = this.inputActions.dequeueAll();
        if (!actions.length) {
            actions = [new NoAction()];
        }

        const actionData = this.serializer.serializePlayerActions(actions.map((action) => ({
            id: (action as unknown as ProcessableAction).actionType,
            params: action.serialize?.() ?? new Uint8Array(),
        })));

        this.submittedTicks.add(tick);
        return this.matchSession.submitLocalTurn(tick, actionData);
    }

    private processResolvedTurn(tick: number, resolvedTurn: LanResolvedTurn): Action[] {
        const processedActions: Action[] = [];

        resolvedTurn.batches.forEach((batch) => {
            const assignment = this.matchSession.getHumanAssignment(batch.peerId);
            if (!assignment) {
                return;
            }

            const player = this.game.getPlayerByName(assignment.name);
            const actionRecords = this.parser.parsePlayerActions(batch.actionData);
            actionRecords.forEach((record) => {
                const action = this.actionFactory.create(record.id as ActionType);
                action.unserialize?.(record.params);
                action.player = player;
                action.process();
                processedActions.push(action);

                const printable = action.print?.();
                if (printable) {
                    this.actionLogger?.debug(`(${action.player.name})@${tick}: ${printable}`);
                }
            });
        });

        resolvedTurn.dropPeerIds.forEach((peerId) => {
            const assignment = this.matchSession.getHumanAssignment(peerId);
            if (!assignment) {
                return;
            }

            const player = this.game.getPlayerByName(assignment.name);
            const action = this.actionFactory.create(ActionType.DropPlayer);
            action.unserialize?.(new Uint8Array());
            action.player = player;
            action.process();
            processedActions.push(action);
            this.actionLogger?.debug(`(${player.name})@${tick}: [drop] peer disconnected`);
        });

        return processedActions;
    }

    private updateLagState(nextLagState: boolean, tick: number): void {
        if (this.lagState === nextLagState) {
            return;
        }
        this.lagState = nextLagState;
        this.onLagStateChange.dispatch(this, nextLagState);
        if (nextLagState) {
            this.lockstepLogger?.warn?.(`[lan] waiting for turn ${tick}${this.passiveMode ? ' (passive)' : ''}`);
        }
    }
}
