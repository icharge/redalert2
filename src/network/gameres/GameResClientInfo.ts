export interface GameResClientInfo {
    clientVers: string;
    avgFps: number;
    avgRtt: number;
    outOfSync: boolean;
    gameSku: number;
    accountName: string;
    suddenDisconnect: boolean;
    quit: boolean;
    finished: boolean;
    pingsRecv: number;
    pingsSent: number;
}
