import { Replay } from './Replay';
import { Parser } from '@/network/gameopt/Parser';
import { Serializer } from '@/network/gameopt/Serializer';
import { TurnActionsReplayEvent } from '@/network/gamestate/replay/TurnActionsReplayEvent';
import { ChatMessageReplayEvent } from '@/network/gamestate/replay/ChatMessageReplayEvent';
import { TauntReplayEvent } from '@/network/gamestate/replay/TauntReplayEvent';
import { ActionSerializer } from '@/network/gamestate/ActionSerializer';
import { ActionType } from '@/game/action/ActionType';
import type { Game } from '@/game/Game';
import type { Action } from '@/game/action/Action';
import type { HumanPlayerInfo } from '@/game/gameopts/GameOpts';
import type { PlayerActionPayload } from '@/network/gamestate/PlayerActionPayload';

export type RecordedActions = Action[] | Map<number, Array<PlayerActionPayload>>;

export class ReplayRecorder {
    constructor(
        private readonly game: Game,
        private readonly replay: Replay,
    ) {}

    recordActions(tick: number, actions: RecordedActions): void {
        const actionSerializer = new ActionSerializer();
        const parser = new Parser();
        const serializer = new Serializer();
        if (Array.isArray(actions)) {
            const event = new TurnActionsReplayEvent(parser, serializer, tick);
            const playerId = this.resolvePlayerId(this.game.localPlayer?.name);
            event.payload = [[playerId, actions.map((action) => actionSerializer.getActionPayload(action))]];
            this.replay.writeEvent(event);
        }
        else if (this.hasActualActions(actions)) {
            const event = new TurnActionsReplayEvent(parser, serializer, tick);
            event.payload = [...actions];
            this.replay.writeEvent(event);
        }
    }

    recordChatMessage(tick: number, playerName: string, message: string): void {
        const event = new ChatMessageReplayEvent(tick);
        event.payload = {
            playerId: this.humanPlayers.findIndex((player) => player.name === playerName),
            message,
        };
        this.replay.writeEvent(event);
    }

    recordTaunt(tick: number, playerName: string, tauntNo: number): void {
        const event = new TauntReplayEvent(tick);
        event.payload = {
            playerId: this.humanPlayers.findIndex((player) => player.name === playerName),
            tauntNo,
        };
        this.replay.writeEvent(event);
    }

    private get humanPlayers(): HumanPlayerInfo[] {
        return this.game.gameOpts?.humanPlayers ?? [];
    }

    private hasActualActions(actions: Map<number, Array<PlayerActionPayload>>): boolean {
        return [...actions.values()].some((playerActions) =>
            playerActions.some((action) => action.id !== ActionType.NoAction));
    }

    private resolvePlayerId(playerName?: string): number {
        if (!playerName) return 0;
        try {
            const player = this.game.getPlayerByName(playerName) as (Player & { index?: number }) | undefined;
            return player?.index ?? 0;
        } catch {
            return 0;
        }
    }
}
