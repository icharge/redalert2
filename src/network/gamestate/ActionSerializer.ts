import type { Action } from '@/game/action/Action';
import type { ProcessableAction } from '@/network/gamestate/PlayerActionPayload';

export class ActionSerializer {
    getActionPayload(action: Action): { id: number; params: Uint8Array } {
        const source = action as unknown as ProcessableAction;
        return {
            id: source.actionType,
            params: source.serialize(),
        };
    }
}
