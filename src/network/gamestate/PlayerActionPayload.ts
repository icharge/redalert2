import type { Player } from '@/game/Player';

export interface PlayerActionPayload {
    id: number;
    params: Uint8Array;
}

export interface ProcessableAction {
    actionType: number;
    player: Player;
    process(): void;
    unserialize?(data: Uint8Array): void;
    serialize?(): Uint8Array;
    print?(): string;
}
