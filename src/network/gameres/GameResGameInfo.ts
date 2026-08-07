export interface GameResGameInfo {
    id: string;
    startTime: number;
    duration: number;
    speed: number;
    players: number;
    mapName: string;
    mapDigest: string;
    unitCount: number;
    cratesAppear: boolean;
    credits: number;
    tournament: boolean;
    shortGame: boolean;
    superWeapons: boolean;
    aiPlayers: number;
    gameMode: number;
    buildOffAlly: boolean;
    mcvRepacks: boolean;
    destroyableBridges: boolean;
    multiEngineer: boolean;
    noDogEngiKills: boolean;
    instantCapture: boolean;
    delayedOils: boolean;
}
