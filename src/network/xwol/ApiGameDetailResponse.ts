export interface ApiGameDetailResponse {
    gameId: string;
    mapName: string;
    players: Array<{
        name: string;
        [key: string]: unknown;
    }>;
    startedAt: number;
    [key: string]: unknown;
}
