export interface ApiGameListEntry {
    gameId: string;
    mapName: string;
    players: number;
    maxPlayers: number;
    startedAt: number;
    [key: string]: any;
}
export interface ApiGameListResponse {
    games: ApiGameListEntry[];
}
