export interface Realm {
    id: string;
    label: string;
    available: boolean;
    gameVersion?: string;
    wolUrl: string;
    apiLoginUrl: string;
    apiRegUrl: string;
    wladderUrl?: string;
    wgameresUrl?: string;
    mapTransferUrl?: string;
    leaderboardUrl?: string;
    errorReportUrl?: string;
}
