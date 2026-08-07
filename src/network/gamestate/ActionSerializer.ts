export class ActionSerializer {
    getActionPayload(action: any): { id: number; params: Uint8Array } {
        return {
            id: action.actionType,
            params: action.serialize(),
        };
    }
}
