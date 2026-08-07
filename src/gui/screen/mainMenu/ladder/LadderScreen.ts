import { jsx } from "@/gui/jsx/jsx";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { Ladder } from "@/gui/screen/mainMenu/ladder/component/Ladder";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { CompositeDisposable } from "@/util/disposable/CompositeDisposable";
import { OperationCanceledError, CancellationToken } from "@puzzl/core/lib/async/cancellation";
import { Task } from "@puzzl/core/lib/async/Task";
import { DownloadError } from "@/network/HttpRequest";
import { WLadderService } from "@/network/ladder/WLadderService";
import { LadderType } from "@/network/ladder/wladderConfig";

interface LadderScreenParams {
    ladderType?: LadderType;
    highlightPlayer?: {
        name: string;
        rank: number;
        ladder?: {
            id: number;
            type: LadderType;
        };
    };
    realm?: any;
}

export class LadderScreen extends MainMenuScreen {
    static PLAYERS_PER_PAGE = 20;

    declare public title: string;
    private disposables = new CompositeDisposable();
    private ladder?: any;
    private isBusy = false;
    private season: string = WLadderService.CURRENT_SEASON;
    private selectedLadderType?: LadderType;
    private selectedLadder?: any;
    private selectedPlayer?: any;
    private realm?: any;
    private seasonDetails?: any;
    private startIndex = 0;
    private totalCount?: number;
    private asyncTask?: Task<void>;

    constructor(
        private wladderService: WLadderService,
        private jsxRenderer: any,
        private errorHandler: any,
        private messageBoxApi: any,
        private strings: any,
        private clientLocale: string,
    ) {
        super();
        this.title = this.strings.get("GUI:Ladder");
    }

    async onEnter(params: LadderScreenParams = {}): Promise<void> {
        this.ladder = undefined;
        this.isBusy = false;
        this.season = WLadderService.CURRENT_SEASON;
        this.selectedLadderType = params.ladderType;
        this.selectedLadder = params.highlightPlayer?.ladder;
        this.selectedPlayer = params.highlightPlayer;
        this.realm = params.realm;
        this.startIndex = this.computePageStartIndex(params.highlightPlayer?.rank);
        this.initSidebar();
        this.initView();
        try {
            await this.fetchInitial(this.selectedLadderType, this.season, this.selectedLadder, params.highlightPlayer, this.startIndex);
        }
        catch (error) {
            if (!(error instanceof OperationCanceledError)) {
                this.handleError(error, this.strings.get("TS:DownloadFailed"), { fatal: true });
            }
        }
    }

    private computePageStartIndex(rank?: number): number {
        let startIndex = 1;
        if (rank !== undefined) {
            startIndex += Math.floor((rank - 1) / LadderScreen.PLAYERS_PER_PAGE) * LadderScreen.PLAYERS_PER_PAGE;
        }
        return startIndex;
    }

    private initSidebar(): void {
        this.controller?.setSidebarButtons([{
            label: this.strings.get("GUI:Back"),
            isBottom: true,
            onClick: () => {
                this.controller?.popScreen();
            },
        }]);
        this.controller?.showSidebarButtons();
    }

    private async fetchInitial(ladderType: LadderType | undefined, season: string, selectedLadder: any, highlightPlayer: any, startIndex: number): Promise<void> {
        await this.runTaskAsync(async (cancellationToken) => {
            const seasons = await this.wladderService.getSeasons(cancellationToken);
            const seasonDetails = await this.wladderService.getSeason(season, this.clientLocale, cancellationToken);
            this.seasonDetails = seasonDetails;
            if (this.selectedLadderType && !seasonDetails.ladders.some((ladder: any) => ladder.type === this.selectedLadderType)) {
                this.selectedLadderType = seasonDetails.ladders[0]?.type;
            }
            let ladderList = this.buildLadderList(ladderType, seasonDetails, selectedLadder);
            this.selectedLadder = selectedLadder ? ladderList.find((ladder: any) => ladder.id === selectedLadder.id) : undefined;
            if (this.selectedLadder) {
                try {
                    const players = await this.wladderService.rungSearch(startIndex, LadderScreen.PLAYERS_PER_PAGE + 1, ladderType, season, this.selectedLadder.id, cancellationToken);
                    this.updateView({
                        head: this.selectedLadder,
                        players,
                        start: startIndex,
                    }, highlightPlayer, seasonDetails, ladderList);
                }
                catch (error) {
                    if (!(error instanceof DownloadError && error.statusCode === 404)) {
                        throw error;
                    }
                    this.updateView(undefined, highlightPlayer, seasonDetails, ladderList);
                }
            }
            else {
                this.updateView(undefined, highlightPlayer, seasonDetails, ladderList);
            }
            if (seasons.length > 1) {
                this.ladder?.applyOptions((options: any) => {
                    options.seasons = seasons;
                });
            }
        });
    }

    private buildLadderList(ladderType: LadderType | undefined, seasonDetails: any, selectedLadder: any, playerProfile?: any): any[] {
        let ladders = seasonDetails.ladders.filter((ladder: any) => ladder.type === ladderType);
        if (selectedLadder && !ladders.some((ladder: any) => ladder.id === selectedLadder.id)) {
            ladders.push(selectedLadder);
        }
        const playerLadder = playerProfile?.ladder;
        if (playerLadder && playerLadder !== selectedLadder && !ladders.some((ladder: any) => ladder.id === playerLadder.id)) {
            ladders.push(playerLadder);
        }
        return ladders;
    }

    private fetchSeasonLadder(season: string, selectedLadder: any, player: any, mode: "season" | "ladder" | "type" | "search"): void {
        this.runTaskAsync(async (cancellationToken) => {
            let seasonDetails = this.seasonDetails;
            if (mode === "season") {
                seasonDetails = await this.wladderService.getSeason(season, this.clientLocale, cancellationToken);
                this.seasonDetails = seasonDetails;
                if (this.selectedLadderType && !seasonDetails.ladders.some((ladder: any) => ladder.type === this.selectedLadderType)) {
                    this.selectedLadderType = seasonDetails.ladders[0]?.type;
                }
            }
            let ladder = selectedLadder;
            if (mode !== "ladder" && player) {
                const playerName = typeof player === "string" ? player : player.name;
                if ((this.selectedLadderType || seasonDetails?.ladders.some((ladder: any) => ladder.type === LadderType.Solo1v1))) {
                    const [result] = await this.wladderService.listSearch([playerName], cancellationToken, this.selectedLadderType, season, this.clientLocale);
                    if (mode === "search") {
                        if (!result || !result.rank) {
                            this.messageBoxApi.show(this.strings.get("TXT_NOT_IN_LADDER"), this.strings.get("GUI:OK"));
                            return;
                        }
                        this.selectedPlayer = result;
                    }
                    else if (result) {
                        this.selectedPlayer = result;
                    }
                    ladder = result?.ladder;
                }
            }
            const searchPlayerProfile = mode === "ladder" ? this.selectedPlayer : undefined;
            let ladderList: any[];
            if (seasonDetails) {
                ladderList = this.buildLadderList(this.selectedLadderType, seasonDetails, ladder, searchPlayerProfile);
                this.selectedLadder = ladder ? ladderList.find((entry: any) => entry.id === ladder.id) : ladderList[0];
            }
            if (this.selectedLadder) {
                let startIndex = 1;
                if (player && player.rank !== undefined) {
                    startIndex = this.computePageStartIndex(player.rank);
                }
                const players = await this.wladderService.rungSearch(startIndex, LadderScreen.PLAYERS_PER_PAGE + 1, this.selectedLadderType, season, this.selectedLadder.id, cancellationToken);
                this.updateView({
                    head: this.selectedLadder,
                    players,
                    start: startIndex,
                }, player ?? this.selectedPlayer, seasonDetails, ladderList);
            }
            else {
                this.updateView(undefined, player ?? this.selectedPlayer, seasonDetails, ladderList);
            }
        }).catch((error: any) => {
            if (!(error instanceof OperationCanceledError)) {
                this.handleError(error, this.strings.get("TS:DownloadFailed"));
            }
        });
    }

    private fetchLadderPage(startIndex: number): void {
        this.runTaskAsync(async (cancellationToken) => {
            if (this.selectedLadder !== undefined) {
                const players = await this.wladderService.rungSearch(startIndex, LadderScreen.PLAYERS_PER_PAGE + 1, this.selectedLadderType, this.season, this.selectedLadder.id, cancellationToken);
                this.updateView({
                    head: this.selectedLadder,
                    players,
                    start: startIndex,
                }, this.selectedPlayer);
            }
        }).catch((error: any) => {
            if (!(error instanceof OperationCanceledError)) {
                this.handleError(error, this.strings.get("TS:DownloadFailed"));
            }
        });
    }

    private async runTaskAsync(task: (cancellationToken: CancellationToken) => Promise<void>): Promise<Task<void>> {
        this.asyncTask?.cancel();
        const asyncTask = this.asyncTask = new Task<void>(task);
        try {
            this.isBusy = true;
            this.ladder?.applyOptions((options: any) => options.disabled = true);
            await asyncTask.start();
        }
        finally {
            this.isBusy = false;
            this.ladder?.applyOptions((options: any) => options.disabled = false);
        }
        return asyncTask;
    }

    private initView(): void {
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            component: Ladder,
            innerRef: (ref: any) => (this.ladder = ref),
            props: {
                players: undefined,
                highlightPlayer: this.selectedPlayer?.name,
                hasPrevPage: false,
                hasNextPage: false,
                seasons: undefined,
                selectedSeason: this.season,
                seasonDetails: this.seasonDetails,
                ladders: undefined,
                selectedLadder: this.selectedLadder,
                strings: this.strings,
                serverRegion: this.realm,
                disabled: this.isBusy,
                onFirstPageClick: () => {
                    if (this.ladder) {
                        this.fetchLadderPage(1);
                    }
                },
                onPrevPageClick: () => {
                    if (this.ladder) {
                        this.fetchLadderPage(Math.max(1, this.startIndex - LadderScreen.PLAYERS_PER_PAGE));
                    }
                },
                onNextPageClick: () => {
                    if (this.ladder) {
                        this.fetchLadderPage(this.startIndex + LadderScreen.PLAYERS_PER_PAGE);
                    }
                },
                onLastPageClick: () => {
                    if (this.ladder && this.totalCount !== undefined) {
                        this.fetchLadderPage(this.computePageStartIndex(this.totalCount));
                    }
                },
                onPlayerSearch: (playerName: string) => {
                    if (this.ladder) {
                        this.fetchSeasonLadder(this.season, this.selectedLadder, playerName, "search");
                    }
                },
                onSeasonSelect: (season: string) => {
                    this.season = season;
                    if (this.ladder) {
                        this.fetchSeasonLadder(season, this.selectedLadder, this.selectedPlayer, "season");
                    }
                },
                onLadderSelect: (ladder: any) => {
                    this.selectedLadder = ladder;
                    if (this.ladder) {
                        this.fetchSeasonLadder(this.season, ladder, this.selectedPlayer, "ladder");
                    }
                },
                onLadderTypeSelect: (ladderType: LadderType) => {
                    this.selectedLadderType = ladderType;
                    this.selectedLadder = undefined;
                    if (this.ladder) {
                        this.fetchSeasonLadder(this.season, this.selectedLadder, this.selectedPlayer, "type");
                    }
                },
            },
        }));
        this.controller?.setMainComponent(component);
    }

    private updateView(turn: any, player: any, seasonDetails?: any, ladderList?: any[]): void {
        this.startIndex = turn?.start ?? 0;
        this.totalCount = turn?.players.totalCount ?? 0;
        this.ladder?.applyOptions((options: any) => {
            if (seasonDetails) {
                options.seasonDetails = seasonDetails;
                options.selectedSeason = this.season;
            }
            if (ladderList) {
                options.ladders = ladderList;
            }
            options.selectedLadder = turn?.head;
            options.highlightPlayer = player?.name;
            options.players = turn?.players.records.slice(0, LadderScreen.PLAYERS_PER_PAGE) ?? [];
            options.hasPrevPage = this.startIndex > 1;
            options.hasNextPage = (turn?.players.records.length ?? 0) > LadderScreen.PLAYERS_PER_PAGE;
        });
    }

    private handleError(error: any, message: string, options: { fatal?: boolean } = {}): void {
        this.errorHandler.handle(error, message, () => {
            if (options.fatal) {
                this.controller?.popScreen();
            }
        });
    }

    async onLeave(): Promise<void> {
        this.disposables.dispose();
        this.ladder = undefined;
        if (this.asyncTask) {
            this.asyncTask.cancel();
            this.asyncTask = undefined;
        }
        await this.controller?.hideSidebarButtons();
    }
}
