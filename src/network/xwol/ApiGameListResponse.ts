export interface ApiGameListEntry {
    gameId: string;
    mapName: string;
    players: number;
    maxPlayers: number;
    startedAt: number;
    [key: string]: unknown;
}
export interface ApiGameListResponse {
    games: ApiGameListEntry[];
}
