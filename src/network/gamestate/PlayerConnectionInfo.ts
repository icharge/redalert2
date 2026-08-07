export interface PlayerConnectionInfo {
    playerName: string;
    status: number;
    loadPercent: number;
    ping: number;
    lagAllowanceMillis: number;
}
