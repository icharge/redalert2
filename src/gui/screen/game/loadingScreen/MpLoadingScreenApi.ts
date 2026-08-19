import { jsx } from '@/gui/jsx/jsx';
import { OBS_COUNTRY_ID, NO_TEAM_ID } from '@/game/gameopts/constants';
import { PlayerConnectionStatus } from '@/network/gamestate/PlayerConnectionStatus';
import { CompositeDisposable } from '@/util/disposable/CompositeDisposable';
import { LoadingScreenWrapper } from './LoadingScreenWrapper';
import { LoadingScreenApi } from './LoadingScreenApi';
interface LoadInfo {
    name: string;
    status: any;
    loadPercent: number;
    ping: number;
    lagAllowanceMillis: number;
    timeoutAt?: number;
}
interface LoadInfoParser {
    parse(data: any): LoadInfo[];
}
interface Player {
    name: string;
    countryId: number;
    colorId: number;
    teamId: number;
}
interface Country {
    name: string;
    side: any;
    uiName: string;
}
interface Rules {
    getMultiplayerColors(): Map<number, any>;
    getMultiplayerCountries(): Country[];
    colors: Map<string, any>;
}
interface Strings {
    get(key: string, ...args: any[]): string;
}
interface UiScene {
    menuViewport: any;
    add(object: any): void;
    remove(object: any): void;
}
interface JsxRenderer {
    render(element: any): any[];
}
interface GameResConfig {
    isCdn(): boolean;
    getCdnBaseUrl(): string;
}
interface GservCon {
    isOpen(): boolean;
    onLoadInfo: {
        subscribe(handler: (info: any) => void): void;
        unsubscribe(handler: (info: any) => void): void;
    };
    requestLoadInfo(): void;
    sendLoadedPercent(percent: number): void;
}
interface ExtendedPlayerInfo {
    name: string;
    status: any;
    loadPercent: number;
    ping: number;
    lagAllowanceMillis: number;
    timeoutAt?: number;
    showLoadTimeoutStatus: boolean;
    country: Country;
    color: string;
    team: number;
}
export class MpLoadingScreenApi implements LoadingScreenApi {
    private lastLoadPercent = 0;
    private loadTimeoutFirstSeenByPlayer = new Map<string, number>();
    private playerLoadInfo?: LoadInfo[];
    private disposables = new CompositeDisposable();
    private players?: Player[];
    private localPlayerName?: string;
    private mapName?: string;
    private loadingScreen?: any;
    private handleLoadInfoUpdate = (loadInfoData: any) => {
        const playerLoadInfo = this.createClientPlayerLoadInfo(this.loadInfoParser.parse(loadInfoData));
        this.playerLoadInfo = playerLoadInfo;
        if (this.loadingScreen) {
            this.updateLoadingScreen(playerLoadInfo);
        }
        else {
            this.createLoadingScreen(playerLoadInfo);
        }
    };
    constructor(private gservCon: GservCon | undefined, private loadInfoParser: LoadInfoParser, private rules: Rules, private strings: Strings, private uiScene: UiScene, private jsxRenderer: JsxRenderer, private gameResConfig: GameResConfig) { }
    async start(players: Player[], mapName: string, localPlayerName: string): Promise<void> {
        this.players = players;
        this.localPlayerName = localPlayerName;
        this.mapName = mapName;
        if (!this.gservCon?.isOpen()) {
            this.handleLoadInfoUpdate(this.createFallbackLoadInfos(0));
            return;
        }
        if (this.gservCon.isOpen()) {
            this.mapName = mapName;
            this.gservCon.onLoadInfo.subscribe(this.handleLoadInfoUpdate);
            this.disposables.add(() => this.gservCon.onLoadInfo.unsubscribe(this.handleLoadInfoUpdate));
            this.gservCon.requestLoadInfo();
            const intervalId = setInterval(() => {
                if (this.gservCon?.isOpen()) {
                    this.gservCon.requestLoadInfo();
                }
                else {
                    this.disposables.dispose();
                }
            }, 10000);
            this.disposables.add(() => clearInterval(intervalId));
            const refreshIntervalId = setInterval(() => {
                if (this.gservCon?.isOpen()) {
                    if (this.loadingScreen && this.playerLoadInfo) {
                        this.updateLoadingScreen(this.playerLoadInfo);
                    }
                }
                else {
                    this.disposables.dispose();
                }
            }, 1000);
            this.disposables.add(() => clearInterval(refreshIntervalId));
        }
    }
    onLoadProgress(percent: number): void {
        const roundedPercent = Math.floor(percent);
        if (roundedPercent > this.lastLoadPercent) {
            this.lastLoadPercent = roundedPercent;
            if (this.gservCon?.isOpen()) {
                this.gservCon.sendLoadedPercent(roundedPercent);
            }
            else if (this.players?.length) {
                this.handleLoadInfoUpdate(this.createFallbackLoadInfos(roundedPercent));
            }
        }
    }
    setSynchronizing(percent: number): void {
        if (!this.localPlayerName || !this.playerLoadInfo || !this.loadingScreen) {
            return;
        }
        const roundedPercent = Math.min(100, Math.max(0, Math.floor(percent)));
        const updated = this.playerLoadInfo.map((info) => info.name === this.localPlayerName
            ? { ...info, loadPercent: roundedPercent }
            : info);
        this.playerLoadInfo = updated;
        this.updateLoadingScreen(updated);
    }
    private createFallbackLoadInfos(loadPercent: number): LoadInfo[] {
        return (this.players ?? []).map((player) => ({
            name: player.name,
            status: PlayerConnectionStatus.Connected,
            loadPercent: player.name === this.localPlayerName ? loadPercent : 0,
            ping: 0,
            lagAllowanceMillis: 0,
        }));
    }
    private createClientPlayerLoadInfo(loadInfos: LoadInfo[]): LoadInfo[] {
        const now = Date.now();
        return loadInfos.map((loadInfo) => {
            const prevInfo = this.playerLoadInfo?.find((info) => info.name === loadInfo.name);
            if (prevInfo?.status === loadInfo.status && prevInfo.timeoutAt === loadInfo.timeoutAt) {
                // unchanged, keep the first-seen timestamp
            }
            else {
                this.loadTimeoutFirstSeenByPlayer.delete(loadInfo.name);
            }
            if (!this.loadTimeoutFirstSeenByPlayer.has(loadInfo.name)) {
                this.loadTimeoutFirstSeenByPlayer.set(loadInfo.name, now);
            }
            return {
                ...loadInfo,
                loadTimeoutFirstSeenAt: this.loadTimeoutFirstSeenByPlayer.get(loadInfo.name),
            };
        });
    }
    private updateLoadingScreen(loadInfos: LoadInfo[]): void {
        this.loadingScreen?.applyOptions((options: any) => {
            options.playerInfos = this.createExtendedLoadingInfos(loadInfos);
        });
    }
    private createExtendedLoadingInfos(loadInfos: LoadInfo[]): ExtendedPlayerInfo[] {
        const colors = [...this.rules.getMultiplayerColors().values()];
        const countries = this.rules.getMultiplayerCountries();
        const hasTeams = this.players?.every(player => player.countryId === OBS_COUNTRY_ID ||
            player.teamId !== NO_TEAM_ID);
        const now = Date.now();
        const extendedInfos = loadInfos
            .map(loadInfo => {
            const player = this.players?.find(p => p.name === loadInfo.name);
            if (!player) {
                return undefined;
            }
            const loadTimeoutFirstSeenAt = (loadInfo as any).loadTimeoutFirstSeenAt as number | undefined;
            return {
                name: loadInfo.name,
                status: loadInfo.status,
                loadPercent: loadInfo.loadPercent,
                ping: loadInfo.ping,
                lagAllowanceMillis: loadInfo.lagAllowanceMillis,
                timeoutAt: loadInfo.timeoutAt,
                showLoadTimeoutStatus: loadTimeoutFirstSeenAt !== undefined && now - loadTimeoutFirstSeenAt >= 10000,
                country: countries[player.countryId],
                color: player.countryId === OBS_COUNTRY_ID
                    ? "#fff"
                    : colors[player.colorId].asHexString(),
                team: player.teamId,
            };
        })
            .filter((info): info is NonNullable<typeof info> => info !== undefined);
        if (hasTeams) {
            extendedInfos.sort((a, b) => {
                if (Boolean(a.country) === Boolean(b.country)) {
                    return a.team - b.team;
                }
                return Number(b.country !== undefined) - Number(a.country !== undefined);
            });
        }
        // The local player must always be listed first on the loading screen.
        const localIndex = extendedInfos.findIndex(info => info.name === this.localPlayerName);
        if (localIndex > 0) {
            const [localInfo] = extendedInfos.splice(localIndex, 1);
            extendedInfos.unshift(localInfo!);
        }
        return extendedInfos;
    }
    private createLoadingScreen(loadInfos: LoadInfo[]): void {
        const [uiObject] = this.jsxRenderer.render(jsx(LoadingScreenWrapper, {
            ref: (ref: any) => (this.loadingScreen = ref),
            strings: this.strings,
            rules: this.rules,
            viewport: this.uiScene.menuViewport,
            playerName: this.localPlayerName,
            mapName: this.mapName!,
            playerInfos: this.createExtendedLoadingInfos(loadInfos),
            gameResConfig: this.gameResConfig,
        }));
        this.uiScene.add(uiObject);
        this.disposables.add(uiObject, () => this.uiScene.remove(uiObject), () => (this.loadingScreen = undefined));
    }
    dispose(): void {
        this.disposables.dispose();
    }
    updateViewport(): void {
        this.loadingScreen?.updateViewport(this.uiScene.menuViewport);
    }
}
