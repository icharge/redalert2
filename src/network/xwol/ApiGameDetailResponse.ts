export interface ApiGameDetailResponse {
    gameId: string;
    mapName: string;
    players: Array<{
        name: string;
        [key: string]: any;
    }>;
    startedAt: number;
    [key: string]: any;
}
