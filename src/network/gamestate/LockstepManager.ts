import { DataStream } from "@/data/DataStream";
import { NoAction } from "@/game/action/NoAction";
import { GameStatus } from "@/game/Game";
import { EventDispatcher } from "@/util/event";
import { LAG_STATE_THRESH_MILLIS } from "@/network/gservConfig";
import { GameSpeed } from "@/game/GameSpeed";
import { computeNetworkTurnMillis } from "@/network/gamestate/lockstepUtil";

export class LockstepManager {
    static PREFERRED_HASH_CHECK_MILLIS = 1_000;

    private gameTurnMillis: number;
    private networkTurnMillis?: number;
    private currentNetworkTurn = 0;
    private currentSubTurn = 0;
    private hashCheckTurnInterval?: number;
    private queuedRateChanges: Array<{ rate: number; turnNo: number }> = [];
    private errorState = false;
    private passiveMode = false;
    private receivedActions = new Map<number, Map<number, Array<{ id: number; params: Uint8Array }>>>();
    private receivedNetworkTurn = 0;
    private commsLagStartTime?: number;
    private lagState = false;
    public debugGameStateHistory: any[] = [];
    private _onLagStateChange = new EventDispatcher<LockstepManager, boolean>();
    private _onActionsSent = new EventDispatcher<LockstepManager, number>();
    private _onActionsProcessed = new EventDispatcher<LockstepManager, number>();
    private _onActionsReceived = new EventDispatcher<LockstepManager, number>();

    get onLagStateChange() {
        return this._onLagStateChange.asEvent();
    }
    get onActionsSent() {
        return this._onActionsSent.asEvent();
    }
    get onActionsProcessed() {
        return this._onActionsProcessed.asEvent();
    }
    get onActionsReceived() {
        return this._onActionsReceived.asEvent();
    }

    constructor(
        private game: any,
        private gservCon: any,
        private gameoptParser: any,
        private gameoptSerializer: any,
        private actionSerializer: any,
        private actionFactory: any,
        private inputActions: { dequeueAll(): any[] },
        private onDesync: () => void,
        private actionLogger?: { debug(message: string): void },
        private netLogger?: { debug?(message: string): void },
        private debugLogger?: (message: string) => void,
        private replayRecorder?: { recordActions?(tick: number, actions: any): void },
        private debugGameState = false,
    ) {
        this.gameTurnMillis = 1000 / (this.game.desiredSpeed.value * GameSpeed.BASE_TICKS_PER_SECOND);
        this.receiveActions = (data: Uint8Array) => {
            const stream = new DataStream(data);
            const turnNo = stream.readUint32();
            const allActions = this.gameoptParser.parseAllPlayerActions(stream);
            this.receivedNetworkTurn = turnNo;
            this.receivedActions.set(turnNo, allActions);
            this._onActionsReceived.dispatch(undefined as any, turnNo);
        };
        this.handleGameDesync = () => {
            this.setErrorState();
            this.onDesync();
        };
    }

    private receiveActions: (data: Uint8Array) => void;
    private handleGameDesync: () => void;

    init(): void {
        this.gameTurnMillis = 1000 / (this.game.desiredSpeed.value * GameSpeed.BASE_TICKS_PER_SECOND);
        this.currentNetworkTurn = 0;
        this.currentSubTurn = 0;
        this.gservCon.onGameActions.subscribe(this.receiveActions);
        this.gservCon.onGameDesync.subscribe(this.handleGameDesync);
        this.debug("Init: gameTurnMillis = " + this.gameTurnMillis);
    }

    canAdvanceNetworkTurn(): boolean {
        return this.currentNetworkTurn < 2 || this.receivedActions.has(this.currentNetworkTurn - 2);
    }

    setErrorState(): void {
        this.errorState = true;
    }

    getErrorState(): boolean {
        return this.errorState;
    }

    setRate(rateChange: { rate: number; turnNo: number }): void {
        this.debug(`Recv rate: ${rateChange.rate} (turn ${rateChange.turnNo})`);
        if (this.currentSubTurn === 0 && this.currentNetworkTurn === 0 && rateChange.turnNo === 0) {
            this.updateRate(rateChange.rate);
        }
        else {
            if (rateChange.turnNo < this.currentNetworkTurn - 2) {
                throw new Error("Rate change has turn number more than two turns in the past.");
            }
            this.queuedRateChanges.push(rateChange);
        }
    }

    private updateRate(rate: number): void {
        this.networkTurnMillis = computeNetworkTurnMillis(rate, this.gameTurnMillis);
        this.hashCheckTurnInterval = Math.ceil(LockstepManager.PREFERRED_HASH_CHECK_MILLIS / this.networkTurnMillis);
        this.netLogger?.debug(`Rate set to ${rate} (${this.networkTurnMillis}ms) @ ` + this.currentNetworkTurn);
    }

    setPassiveMode(passive: boolean): void {
        this.debug("Send passive: " + passive);
        this.passiveMode = passive;
        this.gservCon.sendPlayerActive(!passive);
    }

    getTurnMillis(): number {
        return this.gameTurnMillis;
    }

    doGameTurn(timestamp: number): boolean {
        if (this.errorState) {
            return false;
        }
        if (!this.networkTurnMillis) {
            throw new Error("Network turn rate should be set by now.");
        }
        if (this.game.status !== GameStatus.Ended) {
            if (this.currentSubTurn === 0) {
                const pendingRateChange = this.queuedRateChanges[0];
                if (pendingRateChange && pendingRateChange.turnNo + 2 === this.currentNetworkTurn) {
                    this.debug(`Process rate ${pendingRateChange.rate} (turn ${pendingRateChange.turnNo})`);
                    this.updateRate(pendingRateChange.rate);
                    this.queuedRateChanges.shift();
                }
                if (!this.canAdvanceNetworkTurn()) {
                    this.handleCommsLag(true, timestamp);
                    this.debug("Lag state: " + this.lagState);
                    return false;
                }
                this.debug("Advance turn");
                if (this.commsLagStartTime && timestamp - this.commsLagStartTime > 0) {
                    this.netLogger?.debug(`Waited ${Math.round(timestamp - this.commsLagStartTime)}ms ` +
                        "for other clients to catch up.");
                }
                this.handleCommsLag(false, timestamp);
                if (!this.passiveMode && this.currentNetworkTurn >= this.receivedNetworkTurn) {
                    this.sendActions();
                }
                if (this.currentNetworkTurn >= 2) {
                    const allActions = this.receivedActions.get(this.currentNetworkTurn - 2);
                    if (allActions) {
                        this.replayRecorder?.recordActions?.(this.game.currentTick, allActions);
                        this.processActions(allActions);
                    }
                    this.receivedActions.delete(this.currentNetworkTurn - 2);
                    this._onActionsProcessed.dispatch(undefined as any, this.currentNetworkTurn - 2);
                }
                this.game.update();
                if (!this.passiveMode && this.currentNetworkTurn % this.hashCheckTurnInterval! === 0) {
                    this.gservCon.sendGameStateHash(this.currentNetworkTurn, this.game.getHash());
                }
                if (this.networkTurnMillis > this.gameTurnMillis) {
                    this.currentSubTurn++;
                }
                else {
                    this.currentNetworkTurn++;
                }
            }
            else {
                this.debug("Update");
                this.game.update();
                this.currentSubTurn++;
                if (this.currentSubTurn >= this.networkTurnMillis / this.gameTurnMillis) {
                    this.currentSubTurn = 0;
                    this.currentNetworkTurn++;
                }
            }
            if (this.debugGameState) {
                const maxHistory = this.networkTurnMillis / this.gameTurnMillis * this.hashCheckTurnInterval!;
                if (this.debugGameStateHistory.length > maxHistory) {
                    this.debugGameStateHistory.shift();
                }
                this.debugGameStateHistory.push(this.game.debugGetState());
            }
        }
        else {
            this.game.update();
        }
        return true;
    }

    private handleCommsLag(lagging: boolean, timestamp: number): void {
        if (lagging) {
            if (!this.commsLagStartTime) {
                this.commsLagStartTime = timestamp;
            }
            if (timestamp - this.commsLagStartTime > LAG_STATE_THRESH_MILLIS) {
                this.updateLagState(true);
            }
        }
        else {
            this.commsLagStartTime = undefined;
            this.updateLagState(false);
        }
    }

    private updateLagState(lagging: boolean): void {
        if (lagging !== this.lagState) {
            this.lagState = lagging;
            this._onLagStateChange.dispatch(undefined as any, lagging);
        }
    }

    private sendActions(): void {
        const actions = this.inputActions.dequeueAll();
        if (!actions.length) {
            actions.push(new NoAction());
        }
        const payload = this.gameoptSerializer.serializePlayerActions(actions.map((action: any) => this.actionSerializer.getActionPayload(action)));
        this.debug("Send actions: " + payload);
        this.gservCon.sendPlayerActions(this.currentNetworkTurn, payload);
        this._onActionsSent.dispatch(undefined as any, this.currentNetworkTurn);
    }

    private processActions(allActions: Map<number, Array<{ id: number; params: Uint8Array }>>): any[] {
        const processedActions: any[] = [];
        [...allActions].forEach(([playerId, actions]) => {
            actions.forEach((actionData) => {
                const action = this.actionFactory.create(actionData.id);
                action.player = this.game.getPlayer(playerId);
                action.unserialize(actionData.params);
                action.process();
                const log = action.print();
                if (log) {
                    this.actionLogger?.debug(`(${action.player.name})@${this.game.currentTick}: ` + log);
                }
                processedActions.push(action);
            });
        });
        return processedActions;
    }

    private debug(message: string): void {
        this.debugLogger?.(`${this.currentNetworkTurn}-${this.currentSubTurn}-${this.game.currentTick}: ` + message);
    }

    dispose(): void {
        this.setErrorState();
        this.gservCon.onGameActions.unsubscribe(this.receiveActions);
        this.gservCon.onGameDesync.unsubscribe(this.handleGameDesync);
    }
}
