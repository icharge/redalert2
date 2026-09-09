export interface PlayerMatchHistoryEntry {
    gameId: string;
    timestamp: number;
    mapName: string;
    result: string;
    [key: string]: unknown;
}
