import { Task } from "@puzzl/core/lib/async/Task";
import { CancellationTokenSource, OperationCanceledError, CancellationToken } from "@puzzl/core/lib/async/cancellation";
import { sleep } from "@puzzl/core/lib/async/sleep";
import { WolConnection, WolHasMapStatus, WolChannelUser } from "@/network/WolConnection";
import { WolError } from "@/network/WolError";
import { SlotType, SlotInfo, PingInfo } from "@/network/gameopt/SlotInfo";
import { Parser } from "@/network/gameopt/Parser";
import { Serializer } from "@/network/gameopt/Serializer";
import { GameOpts, AiDifficulty } from "@/game/gameopts/GameOpts";
import { GameOptSanitizer } from "@/game/gameopts/GameOptSanitizer";
import { RANDOM_COUNTRY_ID, RANDOM_COLOR_ID, RANDOM_START_POS, NO_TEAM_ID, OBS_COUNTRY_ID, OBS_COLOR_ID, RANDOM_COUNTRY_NAME, OBS_COUNTRY_NAME, RANDOM_COLOR_NAME, RANDOM_COUNTRY_UI_NAME, OBS_COUNTRY_UI_NAME, RANDOM_COUNTRY_UI_TOOLTIP, OBS_COUNTRY_UI_TOOLTIP, aiUiNames } from "@/game/gameopts/constants";
import { LobbyForm } from "@/gui/screen/mainMenu/lobby/component/LobbyForm";
import { LobbyType, SlotOccupation, SlotType as ViewModelSlotType, PlayerStatus } from "@/gui/screen/mainMenu/lobby/component/viewmodel/lobby";
import { PasswordBox } from "@/gui/screen/mainMenu/lobby/component/PasswordBox";
import { CreateGameBox } from "@/gui/screen/mainMenu/lobby/component/CreateGameBox";
import { ScreenType } from "@/gui/screen/mainMenu/ScreenType";
import { MainMenuRoute } from "@/gui/screen/mainMenu/MainMenuRoute";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { CompositeDisposable } from "@/util/disposable/CompositeDisposable";
import { jsx } from "@/gui/jsx/jsx";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { DownloadError } from "@/network/HttpRequest";
import { MapPreviewRenderer } from "@/gui/screen/mainMenu/lobby/MapPreviewRenderer";
import { findIndexReverse } from "@/util/array";
import { SoundKey } from "@/engine/sound/SoundKey";
import { ChannelType } from "@/engine/sound/ChannelType";
import { LocalPrefs, StorageKey } from "@/LocalPrefs";
import { PreferredHostOpts } from "@/gui/screen/mainMenu/lobby/PreferredHostOpts";
import { isNotNullOrUndefined } from "@/util/typeGuard";
import { MapFile } from "@/data/MapFile";
import { MapDigest } from "@/engine/MapDigest";
import { MAX_MAP_TRANSFER_BYTES } from "@/network/WolConfig";
import { WolGameStartAbortReason } from "@/network/WolGameStartAbortReason";
import { ChatRecipientType } from "@/network/chat/ChatMessage";
import { ChatHistory } from "@/gui/chat/ChatHistory";
import { createThrottledMethod } from "@/util/time";
import { RPL_PARTY_INVITE } from "@/network/partyCodes";
import type { VirtualFile } from "@/data/vfs/VirtualFile";
import type { MapManifest } from "@/engine/MapManifest";
import type { GameModeEntry } from "@/game/ini/GameModes";

function blockInviteOutsideQuickMatch(message: string, onBlocked: (text: string) => void, strings: any): boolean {
    return !!message.trim().toLowerCase().startsWith("/invite") && (onBlocked(strings.get("GUI:PartyInviteInviterNotInQuickMatch")), true);
}

interface GameModes {
    getById(id: number): GameModeEntry;
    hasId(id: number): boolean;
    getAll(): GameModeEntry[];
}

interface MapList {
    getByName(name: string): MapManifest | undefined;
    getAll(): MapManifest[];
}

interface MapFileLoader {
    load(mapName: string, cancellationToken?: any): Promise<VirtualFile>;
}

interface WolService {
    getConfig(): any;
    isConnected(): boolean;
    onWolConnectionLost: {
        subscribe(handler: (error: any) => void): void;
        unsubscribe(handler: (error: any) => void): void;
    };
}

interface WladderService {
    getUrl(): string;
    listSearch(playerNames: string[], cancellationToken: any): Promise<any[]>;
}

interface MapTransferService {
    getUrl(): string | undefined;
}

interface GservConnection {
    connect(url: string, options?: any): Promise<void>;
    ping(timeoutSeconds: number): Promise<number>;
    close(): void;
    isOpen(): boolean;
}

interface RootController {
    createGame(gameId: string, timestamp: number, gameServer?: string, playerName?: string, gameOpts?: any, singlePlayer?: boolean, tournament?: boolean, mapTransfer?: boolean, createPrivateGame?: boolean, returnTo?: any): void;
    joinGame(gameId: string, timestamp: number, gservUrl: string, playerName?: string, tournament?: boolean, mapTransfer?: boolean, returnTo?: any): void;
}

interface ErrorHandler {
    handle(error: any, message: string, onClose: () => void): void;
}

interface MessageBoxApi {
    show(message: string, buttonText?: string, onClose?: () => void): void;
    destroy(): void;
}

interface Sound {
    play(key: SoundKey, channel: ChannelType): void;
}

interface Rules {
    getMultiplayerCountries(): any[];
    getMultiplayerColors(): Map<string, any>;
    mpDialogSettings: any;
    general: any;
}

interface LobbyScreenParams {
    create?: boolean;
    game?: any;
    observe?: boolean;
}

interface CreateGameOptions {
    roomDesc: string;
    observe: boolean;
    pass?: string;
    tournament: boolean;
}

interface LobbyFormModel {
    strings: any;
    lobbyType: LobbyType;
    mpDialogSettings: any;
    selectedGameServer?: string;
    playerSlots: any[];
    shortGame: boolean;
    mcvRepacks: boolean;
    cratesAppear: boolean;
    superWeapons: boolean;
    hostTeams: boolean;
    destroyableBridges: boolean;
    multiEngineer: boolean;
    multiEngineerCount: number;
    noDogEngiKills: boolean;
    instantCapture: boolean;
    delayedOils: boolean;
    gameSpeed: number;
    credits: number;
    unitCount: number;
    buildOffAlly: boolean;
    messages: any[];
    localUsername: string;
    channels: string[];
    chatHistory: ChatHistory;
    activeSlotIndex: number;
    countryUiNames: Map<string, string>;
    countryUiTooltips: Map<string, string>;
    availablePlayerCountries: string[];
    availablePlayerColors: string[];
    availableStartPositions: number[];
    teamsAllowed: boolean;
    teamsRequired: boolean;
    maxTeams: number;
    availableAiNames: Map<AiDifficulty, string>;
    onSlotChange: (occupation: number, slotIndex: number, aiDifficulty?: any) => void;
    onToggleShortGame: (checked: boolean) => void;
    onToggleMcvRepacks: (checked: boolean) => void;
    onToggleCratesAppear: (checked: boolean) => void;
    onToggleSuperWeapons: (checked: boolean) => void;
    onToggleHostTeams: (checked: boolean) => void;
    onToggleDestroyableBridges: (checked: boolean) => void;
    onToggleMultiEngineer: (checked: boolean) => void;
    onToggleNoDogEngiKills: (checked: boolean) => void;
    onToggleInstantCapture: (checked: boolean) => void;
    onToggleDelayedOils: (checked: boolean) => void;
    onChangeGameSpeed: (value: number) => void;
    onChangeCredits: (value: number) => void;
    onChangeUnitCount: (value: number) => void;
    onToggleBuildOffAlly: (checked: boolean) => void;
    onSendMessage: (message: any) => void;
    onCountrySelect: (country: any, slotIndex: number) => void;
    onColorSelect: (color: any, slotIndex: number) => void;
    onStartPosSelect: (pos: any, slotIndex: number) => void;
    onTeamSelect: (team: any, slotIndex: number) => void;
}

export class LobbyScreen extends MainMenuScreen {
    private botsEnabled: boolean;
    private engineVersion: string;
    private engineModHash: string;
    private activeModMeta?: any;
    private rootController: RootController;
    private errorHandler: ErrorHandler;
    private messageBoxApi: MessageBoxApi;
    private strings: any;
    private uiScene: any;
    private wolCon: WolConnection;
    private wolService: WolService;
    private wladderService: WladderService;
    private mapTransferService: MapTransferService;
    private gservCon: GservConnection;
    private rules: Rules;
    private gameOptParser: Parser;
    private gameOptSerializer: Serializer;
    private jsxRenderer: any;
    private mapFileLoader: MapFileLoader;
    private mapList: MapList;
    private gameModes: GameModes;
    private sound: Sound;
    private localPrefs: LocalPrefs;

    private messages: any[] = [];
    private playerReadyStatus: Map<string, boolean> = new Map();
    private playerHasMapStatus: Map<string, WolHasMapStatus> = new Map();
    private acceptButtonFlashing: boolean = false;
    private startGamePending: boolean = false;
    private playerProfiles: Map<string, any> = new Map();
    private disposables: CompositeDisposable = new CompositeDisposable();

    private playerPings: PingInfo[] = [];
    private gameChannelName?: string;
    private hostMode: boolean = false;
    private hostPlayerName?: string;
    private hostIsFreshAccount?: boolean;
    private hostRoomDesc: string = "";
    private isTournament: boolean = false;
    private hostPrivateGame: boolean = false;
    private observerSlotIndex: number = 8;
    private gameOpts?: GameOpts;
    private slotsInfo?: SlotInfo[];
    private currentMapFile?: VirtualFile;
    private preferredHostOpts?: PreferredHostOpts;
    private formModel!: LobbyFormModel;
    private lobbyForm?: any;
    private passBox?: any;
    private createGameBox?: any;
    private currentGameServer?: any;
    private chatHistory!: ChatHistory;

    private pingsUpdateTask?: Task<void>;
    private ranksUpdateTask?: Task<void>;
    private gservPingUpdateTask?: Task<void>;
    private mapLoadTask?: Task<void>;
    private hostOptsIntervalId?: number;
    private gservPingIntervalId?: number;

    private sendGameOpts: () => Promise<void> = createThrottledMethod(async () => {
        this.sendGameOptsNow();
    }, 350);
    private sendGameSlotInfo: () => Promise<void> = createThrottledMethod(async () => {
        this.sendGameSlotInfoNow();
    }, 350);
    private updateGservPing: () => Promise<void> = createThrottledMethod(async () => {
        this.updateGservPingNow();
    }, 5000);

    constructor(
        botsEnabled: boolean,
        engineVersion: string,
        engineModHash: string,
        activeModMeta: any,
        rootController: RootController,
        errorHandler: ErrorHandler,
        messageBoxApi: MessageBoxApi,
        strings: any,
        uiScene: any,
        wolCon: WolConnection,
        wolService: WolService,
        wladderService: WladderService,
        mapTransferService: MapTransferService,
        gservCon: GservConnection,
        rules: Rules,
        gameOptParser: Parser,
        gameOptSerializer: Serializer,
        jsxRenderer: any,
        mapFileLoader: MapFileLoader,
        mapList: MapList,
        gameModes: GameModes,
        sound: Sound,
        localPrefs: LocalPrefs,
    ) {
        super();
        this.botsEnabled = botsEnabled;
        this.engineVersion = engineVersion;
        this.engineModHash = engineModHash;
        this.activeModMeta = activeModMeta;
        this.rootController = rootController;
        this.errorHandler = errorHandler;
        this.messageBoxApi = messageBoxApi;
        this.strings = strings;
        this.uiScene = uiScene;
        this.wolCon = wolCon;
        this.wolService = wolService;
        this.wladderService = wladderService;
        this.mapTransferService = mapTransferService;
        this.gservCon = gservCon;
        this.rules = rules;
        this.gameOptParser = gameOptParser;
        this.gameOptSerializer = gameOptSerializer;
        this.jsxRenderer = jsxRenderer;
        this.mapFileLoader = mapFileLoader;
        this.mapList = mapList;
        this.gameModes = gameModes;
        this.sound = sound;
        this.localPrefs = localPrefs;

        this.updatePings = () => {
            if (this.wolCon.isOpen()) {
                if (this.gameChannelName && this.wolCon.isInChannel(this.gameChannelName)) {
                    this.pingsUpdateTask?.cancel();
                    const task = (this.pingsUpdateTask = new Task(async (cancellationToken) => {
                        const users = await this.wolCon.listUsers(this.gameChannelName!);
                        if (!cancellationToken.isCancelled()) {
                            for (const user of users) {
                                this.updatePlayerPing(user.name, user.ping);
                            }
                            this.sendPingData();
                        }
                    }));
                    task.start().catch((error) => {
                        if (!(error instanceof OperationCanceledError)) {
                            console.error(error);
                        }
                    });
                }
            }
            else {
                this.onWolClose();
            }
        };

        this.updateRanks = () => {
            if (this.wladderService.getUrl() && this.slotsInfo) {
                this.ranksUpdateTask?.cancel();
                const task = (this.ranksUpdateTask = new Task(async (cancellationToken) => {
                    await sleep(5000, cancellationToken);
                    const playerNames = this.slotsInfo!
                        .map((slot) => (slot.type === SlotType.Player ? slot.name : undefined))
                        .filter(isNotNullOrUndefined);
                    const profiles = await this.wladderService.listSearch(playerNames, cancellationToken);
                    if (!cancellationToken.isCancelled()) {
                        for (const profile of profiles) {
                            this.playerProfiles.set(profile.name, profile);
                        }
                        this.updateFormModel();
                    }
                }));
                task.start().catch((error) => {
                    if (!(error instanceof OperationCanceledError)) {
                        console.error(error);
                    }
                });
            }
        };

        this.handlePartyUpdate = (update: string) => {
            const parts = update.split(" ");
            if (parts[0] !== RPL_PARTY_INVITE) {
                return;
            }
            const playerName = parts[1];
            if (playerName) {
                this.wolCon.partyInviteUnavailable(playerName);
            }
        };

        this.onChannelLeave = (event: any) => {
            if (event.channel === this.gameChannelName) {
                if (this.hostMode) {
                    if (event.user.name !== this.wolCon.getCurrentUser()) {
                        this.handlePlayerJoinLeave(event);
                    }
                }
                else if (event.user.name === this.hostPlayerName || event.user.name === this.wolCon.getCurrentUser()) {
                    this.controller?.goToScreen(ScreenType.CustomGame as any, {});
                }
            }
        };

        this.onChannelJoin = (event: any) => {
            if (this.wolCon.isOpen() && this.gameChannelName && event.user.name !== this.wolCon.getCurrentUser()) {
                this.sound.play(event.type === "join" ? SoundKey.PlayerJoined : SoundKey.PlayerLeft, ChannelType.Ui);
                if (event.type === "join") {
                    this.updatePlayerPing(event.user.name, event.user.ping);
                }
                if (this.hostMode) {
                    this.handlePlayerJoinLeave(event);
                }
                else {
                    this.wolCon.sendPlayerReady(false);
                }
                if (!this.playerProfiles.has(event.user.name)) {
                    this.updateRanks();
                }
            }
        };

        this.onChannelMessage = (message: any) => {
            if (this.lobbyForm) {
                if (message.to.type === ChatRecipientType.Page || message.to.type === ChatRecipientType.Whisper) {
                    this.sound.play(SoundKey.IncomingMessage, ChannelType.Ui);
                }
                this.messages.push(message);
                this.lobbyForm.refresh();
            }
            if (message.to.type === ChatRecipientType.Whisper &&
                message.to.name !== this.wolCon.getServerName() &&
                message.from !== this.wolCon.getCurrentUser()) {
                (this.chatHistory as any).lastWhisperFrom.value = message.from;
            }
        };

        this.handleGameStart = (event: any) => {
            this.setStartGamePending(false);
            const username = this.wolCon.getCurrentUser();
            const fallbackRoute = new MainMenuRoute(ScreenType.Login as any, {
                forceRestoreSession: true,
                afterLogin: (messages: any[]) => new MainMenuRoute(ScreenType.CustomGame as any, { messages }),
            });
            const mapTransfer = this.hostMode
                ? [...this.playerHasMapStatus.values()].includes(WolHasMapStatus.MapTransfer)
                : this.playerHasMapStatus.get(username!) === WolHasMapStatus.MapTransfer;
            if (this.hostMode) {
                this.rootController.createGame(
                    event.gameId,
                    event.timestamp,
                    event.gservUrl,
                    username!,
                    this.gameOpts!,
                    false,
                    this.isTournament,
                    mapTransfer,
                    this.hostPrivateGame,
                    fallbackRoute,
                );
            }
            else {
                this.rootController.joinGame(
                    event.gameId,
                    event.timestamp,
                    event.gservUrl,
                    username!,
                    this.isTournament,
                    mapTransfer,
                    fallbackRoute,
                );
            }
        };

        this.handleGameStartAbort = (event: any) => {
            this.setStartGamePending(false);
            let message: string;
            if (event.reason === WolGameStartAbortReason.PlayerLeft) {
                message = this.strings.get("error:playerleftgameaborted");
            }
            else if (event.reason === WolGameStartAbortReason.ServiceUnavailable) {
                message = this.strings.get("ts:serviceunavailable");
            }
            else {
                message = this.strings.get("wol:matchbadparameters");
            }
            this.messageBoxApi.show(message, this.strings.get("GUI:Ok"));
        };

        this.handleGameServer = (event: any) => {
            if (this.currentGameServer?.id !== event.id) {
                this.currentGameServer = event;
                this.formModel.selectedGameServer = event.id;
                this.playerPings.length = 0;
                this.lobbyForm?.refresh();
                if (this.hostMode) {
                    this.updatePings();
                }
                this.updateGservPing();
            }
        };

        this.handleGameOpt = (event: { user: string; opt: string }) => {
            const opt = event.opt;
            const optType = opt[0];
            if (this.hostMode) {
                if (event.user !== this.hostPlayerName) {
                    if (optType === "A") {
                        this.handleGameOptReady(event.user, opt[1]);
                    }
                    else if (optType === "R") {
                        this.handlePlayerOptsChange(event.user, opt);
                    }
                    else if (optType === "K") {
                        this.handleGameOptHasMap(event.user, opt[1]);
                    }
                    else {
                        throw new Error("Unknown GAMEOPT string " + opt);
                    }
                }
            }
            else if (optType === "L") {
                this.handleGameOptSlots(opt);
                if (this.slotsInfo!.some((slot) => slot.type === SlotType.Player && !this.playerProfiles.has(slot.name!))) {
                    this.updateRanks();
                }
            }
            else if (optType === "P") {
                this.handleGameOptPing(opt.slice(1));
            }
            else if (optType === "O") {
                this.handleGameOptObserver(opt[1]);
            }
            else if (optType === "A") {
                this.handleGameOptReady(event.user, opt[1]);
            }
            else if (optType === "K") {
                this.handleGameOptHasMap(event.user, opt[1]);
            }
            else if (optType === "R") {
                return;
            }
            else if (optType === "G") {
                if (!this.playerReadyStatus.get(this.wolCon.getCurrentUser()!)) {
                    this.addSystemMessage(this.strings.get("GUI:HostGameStartJoiner"));
                    this.acceptButtonFlashing = true;
                    this.refreshSidebarButtons();
                }
                return;
            }
            else if (!optType.match(/^-|\d+/)) {
                throw new Error("Unknown GAMEOPT string " + opt);
            }
            else {
                this.handleGameOptOptions(opt);
            }
            this.updateFormModel();
        };

        this.onWolClose = () => {
            this.setStartGamePending(false);
            if (this.hostOptsIntervalId) {
                clearInterval(this.hostOptsIntervalId);
            }
            if (this.gservPingIntervalId) {
                clearInterval(this.gservPingIntervalId);
            }
        };

        this.onWolConLost = (error: any) => {
            this.errorHandler.handle(error, this.strings.get("TXT_YOURE_DISCON"), () => {
                this.controller?.goToScreen(ScreenType.Home as any);
            });
        };
    }

    private updatePings: () => void;
    private updateRanks: () => void;
    private handlePartyUpdate: (update: string) => void;
    private onChannelLeave: (event: any) => void;
    private onChannelJoin: (event: any) => void;
    private onChannelMessage: (message: any) => void;
    private handleGameStart: (event: any) => void;
    private handleGameStartAbort: (event: any) => void;
    private handleGameServer: (event: any) => void;
    private handleGameOpt: (event: { user: string; opt: string }) => void;
    private onWolClose: () => void;
    private onWolConLost: (error: any) => void;

    async onEnter(params: LobbyScreenParams): Promise<void> {
        if (this.wolCon.getCurrentUser()) {
            const cancellationSource = new CancellationTokenSource();
            this.disposables.add(() => cancellationSource.cancel());
            const cancellationToken = cancellationSource.token;
            this.gameChannelName = undefined;
            this.lobbyForm = undefined;
            this.chatHistory = new ChatHistory();
            this.playerPings = [];
            this.initFormModel();
            this.wolCon.onGameOpt.subscribe(this.handleGameOpt);
            this.wolCon.onGameStart.subscribe(this.handleGameStart);
            this.wolCon.onGameStartAbort.subscribe(this.handleGameStartAbort);
            this.wolCon.onGameServer.subscribe(this.handleGameServer);
            this.wolCon.onLeaveChannel.subscribe(this.onChannelLeave);
            this.wolCon.onJoinGameChannel.subscribe(this.onChannelJoin);
            this.wolCon.onChatMessage.subscribe(this.onChannelMessage);
            this.wolCon.onClose.subscribe(this.onWolClose);
            this.wolCon.onPartyUpdate.subscribe(this.handlePartyUpdate);
            this.wolService.onWolConnectionLost.subscribe(this.onWolConLost);
            this.hostMode = !!params.create;
            if (this.hostMode) {
                this.title = this.strings.get("GUI:HostScreen");
                this.createGame(cancellationToken);
            }
            else {
                this.title = this.strings.get("GUI:JoinScreen");
                const { game, observe } = params;
                this.joinGame(game!, !!observe, undefined, cancellationToken);
            }
        }
        else {
            this.messageBoxApi.show(this.strings.get("TXT_YOURE_DISCON"), this.strings.get("GUI:Ok"), () => {
                this.controller?.goToScreen(ScreenType.Home as any);
            });
        }
    }

    private async joinGame(game: any, observe: boolean, password?: string, cancellationToken?: CancellationToken): Promise<void> {
        if (password || !game.passLocked) {
            const channelName = game.name;
            try {
                const hostPlayerPromise = this.waitForHostPlayer(channelName, cancellationToken!).catch((error) => {
                    if (!(error instanceof OperationCanceledError)) {
                        throw error;
                    }
                });
                await this.wolCon.joinGame(channelName, password, observe);
                if (cancellationToken?.isCancelled()) {
                    return;
                }
                this.gameChannelName = channelName;
                const hostPlayer = await hostPlayerPromise;
                if (cancellationToken?.isCancelled()) {
                    return;
                }
                this.hostPlayerName = (hostPlayer as WolChannelUser).name;
                this.hostIsFreshAccount = (hostPlayer as WolChannelUser).fresh;
                this.isTournament = game.tournament;
                this.formModel.channels = [this.gameChannelName];
                if (observe) {
                    this.sendPlayerInfo(OBS_COUNTRY_ID, RANDOM_COLOR_ID, RANDOM_START_POS, NO_TEAM_ID);
                }
                else {
                    const savedCountry = this.localPrefs.getItem(StorageKey.LastPlayerCountry);
                    const savedColor = this.localPrefs.getItem(StorageKey.LastPlayerColor);
                    const countryId = savedCountry !== undefined && Number(savedCountry) < this.getAvailablePlayerCountries().length
                        ? Number(savedCountry)
                        : RANDOM_COUNTRY_ID;
                    const colorId = savedColor !== undefined &&
                        Number(savedColor) < this.getAvailablePlayerColors().length &&
                        this.getSelectablePlayerColors().includes(this.getColorNameById(Number(savedColor)))
                        ? Number(savedColor)
                        : RANDOM_COLOR_ID;
                    if (!(countryId === RANDOM_COUNTRY_ID && colorId === RANDOM_COLOR_ID)) {
                        this.sendPlayerInfo(countryId, colorId, RANDOM_START_POS, NO_TEAM_ID);
                    }
                }
                this.observerSlotIndex = 8;
            }
            catch (error) {
                if (error instanceof WolError) {
                    const errorMessages = new Map<number, string>()
                        .set(WolError.Code.BadChannelPass, "TXT_BADPASS")
                        .set(WolError.Code.GameHasClosed, "TXT_GAME_CLOSED")
                        .set(WolError.Code.ChannelFull, "TXT_CHANNEL_FULL")
                        .set(WolError.Code.BannedFromChannel, "TXT_JOINBAN")
                        .set(WolError.Code.RateLimited, "WOL:JoinedTooManyInstances");
                    const messageKey = errorMessages.get(error.code);
                    if (messageKey) {
                        this.messageBoxApi.show(this.strings.get(messageKey), this.strings.get("GUI:Ok"), () => {
                            this.controller?.goToScreen(ScreenType.CustomGame as any, {});
                        });
                        return;
                    }
                }
                else if (error instanceof OperationCanceledError) {
                    return;
                }
                this.handleError(error, this.strings.get("WOL:MatchBadParameters"));
                return;
            }
            this.controller.toggleSidebarPreview(true);
            this.initView();
        }
        else {
            this.showPasswordBox((enteredPassword: string) => {
                this.joinGame(game, observe, enteredPassword, cancellationToken);
            }, () => {
                this.controller?.goToScreen(ScreenType.CustomGame as any, {});
            });
        }
    }

    private waitForHostPlayer(channelName: string, cancellationToken: CancellationToken): Promise<WolChannelUser> {
        return new Promise((resolve, reject) => {
            const handler = (event: { channelName: string; users: WolChannelUser[] }) => {
                if (event.channelName === channelName) {
                    this.wolCon.onChannelUsers.unsubscribe(handler);
                    const hostPlayer = event.users.find((user) => user.operator);
                    if (hostPlayer) {
                        resolve(hostPlayer);
                    }
                    else {
                        reject(new Error("Host player not found"));
                    }
                }
            };
            this.wolCon.onChannelUsers.subscribe(handler);
            cancellationToken.register(() => {
                this.wolCon.onChannelUsers.unsubscribe(handler);
                reject(new OperationCanceledError(cancellationToken));
            });
        });
    }

    private async createGame(cancellationToken: CancellationToken, options?: CreateGameOptions): Promise<void> {
        if (options) {
            try {
                const { roomDesc, tournament, observe, pass } = options;
                const channelName = this.wolCon.makeGameChannelName();
                const hostPlayerPromise = this.waitForHostPlayer(channelName, cancellationToken).catch((error) => {
                    if (!(error instanceof OperationCanceledError)) {
                        throw error;
                    }
                });
                await this.wolCon.createGame(channelName, 1, 9, this.wolService.getConfig().getClientChannelType(), tournament, pass, observe);
                if (cancellationToken.isCancelled()) {
                    return;
                }
                this.gameChannelName = channelName;
                const hostPlayer = await hostPlayerPromise;
                if (cancellationToken.isCancelled()) {
                    return;
                }
                this.hostPlayerName = this.wolCon.getCurrentUser();
                this.hostIsFreshAccount = (hostPlayer as WolChannelUser | undefined)?.fresh ?? false;
                this.hostRoomDesc = roomDesc;
                this.isTournament = tournament;
                this.hostPrivateGame = !!pass;
                this.observerSlotIndex = observe ? 0 : 8;
                this.formModel.lobbyType = LobbyType.MultiplayerHost;
                this.formModel.activeSlotIndex = observe ? -1 : 0;
                this.formModel.channels = [this.gameChannelName];
                await this.initHostOptions(observe, cancellationToken);
                if (cancellationToken.isCancelled()) {
                    return;
                }
                this.updateMapPreview(this.currentMapFile);
                this.updateFormModel();
                this.updatePings();
                this.updateRanks();
                this.sendGameOpts();
                this.sendModeMaxSlots();
                this.hostOptsIntervalId = window.setInterval(() => {
                    if (this.wolCon.isOpen() && this.gameChannelName) {
                        this.sendGameOpts();
                        this.updatePings();
                    }
                }, 5000);
            }
            catch (error) {
                let message = this.strings.get("WOL:MatchBadParameters");
                if (error instanceof DownloadError) {
                    message = this.strings.get("TXT_DOWNLOAD_FAILED");
                }
                else if (error instanceof WolError && error.code === WolError.Code.RateLimited) {
                    message = this.strings.get("WOL:CreatedTooManyInstances");
                }
                this.handleError(error, message);
                return;
            }
            this.controller.toggleSidebarPreview(true);
            this.initView();
        }
        else {
            this.showCreateGameBox((roomDesc: string, pass: string, observe: boolean) => {
                this.createGame(cancellationToken, {
                    roomDesc,
                    observe,
                    pass,
                    tournament: false,
                });
            }, () => {
                this.controller?.goToScreen(ScreenType.CustomGame as any, {});
            });
        }
    }

    onViewportChange(): void {
        if (this.createGameBox) {
            this.createGameBox.applyOptions((options: any) => (options.viewport = this.uiScene.viewport));
        }
        if (this.passBox) {
            this.passBox.applyOptions((options: any) => (options.viewport = this.uiScene.viewport));
        }
    }

    onUnstack(result: any): void {
        if (this.wolCon.isOpen() && this.gameChannelName) {
            if (result) {
                const modeChanged = result.gameMode.id !== this.gameOpts!.gameMode;
                const mapChanged = result.mapName !== this.gameOpts!.mapName;
                this.gameOpts!.gameMode = result.gameMode.id;
                const mapManifest = this.mapList.getByName(result.mapName)!;
                const changedMapFile = result.changedMapFile ?? this.currentMapFile;
                this.currentMapFile = changedMapFile;
                const lastOccupiedSlot = findIndexReverse(this.slotsInfo!, (slot, slotIndex) =>
                    slot.type === SlotType.Ai ||
                    (slot.type === SlotType.Player && (this.observerSlotIndex !== slotIndex || slotIndex === 0)) ||
                    slot.type === SlotType.Open);
                const slotCount = Math.min(9, mapManifest.maxSlots + (this.observerSlotIndex === 0 ? 1 : 0));
                const overflow = Math.max(0, lastOccupiedSlot + 1 - slotCount);
                for (let i = 0; i < overflow; i++) {
                    const slot = this.slotsInfo![lastOccupiedSlot - i];
                    if (slot.type === SlotType.Player) {
                        this.kickPlayer(slot.name!);
                    }
                    else if (slot.type === SlotType.Ai) {
                        this.gameOpts!.aiPlayers[lastOccupiedSlot - i] = undefined;
                    }
                    slot.type = SlotType.Closed;
                }
                for (let slotIndex = lastOccupiedSlot + 1; slotIndex < slotCount; slotIndex++) {
                    this.slotsInfo![slotIndex].type = this.preferredHostOpts!.slotsClosed.has(slotIndex)
                        ? SlotType.Closed
                        : this.observerSlotIndex === slotIndex
                            ? SlotType.OpenObserver
                            : SlotType.Open;
                }
                const mpDialogSettings = this.gameModes.getById(this.gameOpts!.gameMode).mpDialogSettings;
                [...this.gameOpts!.humanPlayers, ...this.gameOpts!.aiPlayers].forEach((player) => {
                    if (player) {
                        if (player.startPos > mapManifest.maxSlots - 1) {
                            player.startPos = RANDOM_START_POS;
                        }
                        if (modeChanged) {
                            player.teamId = mpDialogSettings.alliesAllowed && mpDialogSettings.mustAlly ? 0 : NO_TEAM_ID;
                        }
                    }
                });
                if (mapChanged) {
                    for (const playerName of this.playerReadyStatus.keys()) {
                        this.playerReadyStatus.set(playerName, false);
                    }
                    this.playerHasMapStatus.clear();
                }
                this.sendGameSlotInfo();
                this.sendModeMaxSlots();
                this.applyGameOption((options) => {
                    options.mapName = mapManifest.fileName;
                    options.mapDigest = MapDigest.compute(changedMapFile);
                    options.mapSizeBytes = changedMapFile.getSize();
                    options.mapTitle = mapManifest.getFullMapTitle(this.strings);
                    options.maxSlots = mapManifest.maxSlots;
                    options.mapOfficial = mapManifest.official;
                });
                this.localPrefs.setItem(StorageKey.LastMap, mapManifest.fileName);
                this.localPrefs.setItem(StorageKey.LastMode, String(result.gameMode.id));
            }
            this.updateMapPreview(this.currentMapFile);
            this.initView();
        }
        else {
            this.onWolClose();
        }
    }

    async onStack(): Promise<void> {
        await this.unrender();
    }

    private initView(): void {
        this.initLobbyForm();
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        this.controller.showSidebarButtons();
        this.gservPingIntervalId = window.setInterval(() => {
            this.updateGservPing();
        }, 30000);
    }

    private async initHostOptions(observe: boolean, cancellationToken?: CancellationToken): Promise<void> {
        const preferredGameOpts = this.localPrefs.getItem(StorageKey.PreferredGameOpts);
        const savedCountry = this.localPrefs.getItem(StorageKey.LastPlayerCountry);
        const savedColor = this.localPrefs.getItem(StorageKey.LastPlayerColor);
        const lastMap = this.localPrefs.getItem(StorageKey.LastMap);
        const lastMode = this.localPrefs.getItem(StorageKey.LastMode);
        let mapManifest = lastMap ? this.mapList.getByName(lastMap) : undefined;
        let modeId = mapManifest && lastMode && this.gameModes.hasId(Number(lastMode)) ? Number(lastMode) : 1;
        let gameMode = this.gameModes.getById(modeId);
        let map: MapManifest;
        if (mapManifest?.gameModes.find((entry) => entry.mapFilter === gameMode.mapFilter)) {
            map = mapManifest;
        }
        else {
            modeId = 1;
            gameMode = this.gameModes.getById(modeId);
            map = this.mapList.getAll().find((manifest) => manifest.gameModes.find((entry) => entry.mapFilter === gameMode.mapFilter))!;
        }
        const mapFile = await this.mapFileLoader.load(map.fileName);
        if (!cancellationToken?.isCancelled()) {
            this.currentMapFile = mapFile;
            const preferredOpts = this.preferredHostOpts = new PreferredHostOpts();
            if (preferredGameOpts) {
                preferredOpts.unserialize(preferredGameOpts);
            }
            else {
                preferredOpts.applyMpDialogSettings(this.rules.mpDialogSettings);
            }
            const mpDialogSettings = this.gameModes.getById(modeId).mpDialogSettings;
            this.gameOpts = {
                gameMode: modeId,
                shortGame: preferredOpts.shortGame,
                mcvRepacks: preferredOpts.mcvRepacks,
                cratesAppear: preferredOpts.cratesAppear,
                superWeapons: preferredOpts.superWeapons,
                gameSpeed: preferredOpts.gameSpeed,
                credits: preferredOpts.credits,
                unitCount: preferredOpts.unitCount,
                buildOffAlly: preferredOpts.buildOffAlly,
                hostTeams: preferredOpts.hostTeams,
                destroyableBridges: preferredOpts.destroyableBridges,
                multiEngineer: preferredOpts.multiEngineer,
                noDogEngiKills: preferredOpts.noDogEngiKills,
                instantCapture: preferredOpts.instantCapture,
                delayedOils: preferredOpts.delayedOils,
                humanPlayers: [{
                    name: this.hostPlayerName!,
                    countryId: observe
                        ? OBS_COUNTRY_ID
                        : savedCountry !== undefined && Number(savedCountry) < this.getAvailablePlayerCountries().length
                            ? Number(savedCountry)
                            : RANDOM_COUNTRY_ID,
                    colorId: !observe && savedColor !== undefined && Number(savedColor) < this.getAvailablePlayerColors().length
                        ? Number(savedColor)
                        : RANDOM_COLOR_ID,
                    startPos: RANDOM_START_POS,
                    teamId: mpDialogSettings.mustAlly ? 0 : NO_TEAM_ID,
                }],
                aiPlayers: new Array(8).fill(undefined),
                mapName: map.fileName,
                mapDigest: MapDigest.compute(mapFile),
                mapSizeBytes: mapFile.getSize(),
                mapTitle: map.getFullMapTitle(this.strings),
                maxSlots: map.maxSlots,
                mapOfficial: map.official,
            };
            this.slotsInfo = [{
                type: SlotType.Player,
                name: this.hostPlayerName!,
            }];
            for (let slotIndex = 1; slotIndex < 9; ++slotIndex) {
                this.slotsInfo.push({
                    type: preferredOpts.slotsClosed.has(slotIndex)
                        ? SlotType.Closed
                        : this.observerSlotIndex === slotIndex
                            ? SlotType.OpenObserver
                            : slotIndex < map.maxSlots + (observe ? 1 : 0)
                                ? SlotType.Open
                                : SlotType.Closed,
                });
            }
            this.playerProfiles.clear();
        }
    }

    private updateGservPingNow(): void {
        if (this.wolCon.isOpen()) {
            if (this.gameChannelName && this.wolCon.isInChannel(this.gameChannelName)) {
                this.gservPingUpdateTask?.cancel();
                const task = (this.gservPingUpdateTask = new Task(async (cancellationToken) => {
                    if (this.currentGameServer) {
                        const url = this.currentGameServer.url;
                        const ping = await this.pingGserv(url, cancellationToken);
                        if (ping !== undefined) {
                            this.wolCon.sendGservPing(this.currentGameServer.id, ping);
                            if (this.hostMode) {
                                this.updatePings();
                            }
                        }
                    }
                }));
                task.start().catch((error) => {
                    if (!(error instanceof OperationCanceledError)) {
                        console.error(error);
                    }
                });
            }
        }
        else {
            this.onWolClose();
        }
    }

    private async pingGserv(url: string, cancellationToken?: CancellationToken): Promise<number | undefined> {
        try {
            await this.gservCon.connect(url, {
                cancelToken: cancellationToken,
                timeoutSeconds: 5,
            });
            cancellationToken?.throwIfCancelled();
            const ping = await this.gservCon.ping(5);
            cancellationToken?.throwIfCancelled();
            return ping;
        }
        catch (error) {
            if (!(error instanceof OperationCanceledError)) {
                console.error(error);
            }
            return undefined;
        }
        finally {
            this.gservCon.close();
        }
    }

    private handleError(error: any, message: string): void {
        this.errorHandler.handle(error, message, () => {
            this.controller?.goToScreen(ScreenType.CustomGame as any, {});
        });
        if (this.hostOptsIntervalId) {
            clearInterval(this.hostOptsIntervalId);
        }
        if (this.gservPingIntervalId) {
            clearInterval(this.gservPingIntervalId);
        }
    }

    private showPasswordBox(onSubmit: (password: string) => void, onDismiss: () => void): void {
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            innerRef: (ref: any) => (this.passBox = ref),
            component: PasswordBox,
            props: {
                strings: this.strings,
                onSubmit: (password: string) => {
                    onSubmit(password);
                    component.destroy();
                },
                onDismiss: () => {
                    onDismiss();
                    component.destroy();
                },
                viewport: this.uiScene.viewport,
            },
        }));
        this.uiScene.add(component);
        this.disposables.add(component, () => this.uiScene.remove(component), () => (this.passBox = undefined));
    }

    private showCreateGameBox(onSubmit: (roomDesc: string, pass: string, observe: boolean) => void, onDismiss: () => void): void {
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            innerRef: (ref: any) => (this.createGameBox = ref),
            component: CreateGameBox,
            props: {
                strings: this.strings,
                onSubmit: (roomDesc: string, pass: string, observe: boolean) => {
                    component.destroy();
                    onSubmit(roomDesc, pass, observe);
                },
                onDismiss: () => {
                    component.destroy();
                    onDismiss();
                },
                viewport: this.uiScene.viewport,
            },
        }));
        this.uiScene.add(component);
        this.disposables.add(component, () => this.uiScene.remove(component), () => (this.createGameBox = undefined));
    }

    private getAvailablePlayerCountryRules(): any[] {
        return this.rules.getMultiplayerCountries();
    }

    private getAvailablePlayerCountries(): string[] {
        return this.getAvailablePlayerCountryRules().map((country) => country.name);
    }

    private getAvailablePlayerColors(): string[] {
        return [...this.rules.getMultiplayerColors().values()].map((color) => color.asHexString());
    }

    private getAvailableStartPositions(): number[] {
        return new Array(this.gameOpts?.maxSlots ?? 8).fill(0).map((_, index) => index);
    }

    private getSelectablePlayerColors(): string[] {
        const usedColors: string[] = [];
        if (this.formModel) {
            this.formModel.playerSlots.forEach((slot) => {
                if (slot) {
                    usedColors.push(slot.color);
                }
            });
        }
        const availableColors = this.getAvailablePlayerColors();
        return [RANDOM_COLOR_NAME].concat(availableColors.filter((color) => color && usedColors.indexOf(color) === -1));
    }

    private getSelectableStartPositions(): number[] {
        const usedPositions: number[] = [];
        if (this.formModel) {
            this.formModel.playerSlots.forEach((slot) => {
                if (slot) {
                    usedPositions.push(slot.startPos);
                }
            });
        }
        const availablePositions = this.getAvailableStartPositions();
        return [RANDOM_START_POS].concat(availablePositions.filter((position) => !usedPositions.includes(position)));
    }

    private initFormModel(): void {
        const mpDialogSettings = this.rules.mpDialogSettings;
        this.formModel = {
            strings: this.strings,
            countryUiNames: new Map<string, string>([
                [RANDOM_COUNTRY_NAME, RANDOM_COUNTRY_UI_NAME],
                [OBS_COUNTRY_NAME, OBS_COUNTRY_UI_NAME],
                ...this.getAvailablePlayerCountryRules().map((country) => [country.name, country.uiName] as [string, string]),
            ]),
            countryUiTooltips: new Map<string, string>([
                [RANDOM_COUNTRY_NAME, RANDOM_COUNTRY_UI_TOOLTIP],
                [OBS_COUNTRY_NAME, OBS_COUNTRY_UI_TOOLTIP],
                ...this.getAvailablePlayerCountryRules().filter((country) => country.uiTooltip).map((country) => [country.name, country.uiTooltip] as [string, string]),
            ]),
            availablePlayerCountries: [RANDOM_COUNTRY_NAME].concat(this.getAvailablePlayerCountries()),
            availablePlayerColors: this.getSelectablePlayerColors(),
            availableAiNames: this.botsEnabled
                ? new Map([...aiUiNames.entries()].filter(([difficulty]) => difficulty !== AiDifficulty.Easy))
                : new Map(),
            availableStartPositions: this.getSelectableStartPositions(),
            maxTeams: 4,
            lobbyType: LobbyType.MultiplayerGuest,
            messages: this.messages,
            chatHistory: this.chatHistory,
            channels: [],
            localUsername: this.wolCon.getCurrentUser()!,
            mpDialogSettings,
            onSendMessage: (message: any) => {
                if (message.value.length) {
                    blockInviteOutsideQuickMatch(message.value, (text) => this.addSystemMessage(text), this.strings) ||
                    (this.wolCon.isOpen() && this.gameChannelName &&
                        (this.wolCon.sendChatMessage(message.value, message.recipient),
                            message.recipient.type === ChatRecipientType.Whisper &&
                            ((this.chatHistory as any).lastWhisperTo.value = message.recipient.name)));
                }
                else {
                    this.addSystemMessage(this.strings.get("TXT_ENTER_MESSAGE"));
                }
            },
            onCountrySelect: (country: any, slotIndex: number) => {
                if (this.wolCon.isOpen() && this.gameChannelName) {
                    this.sendPlayerInfo(
                        this.getCountryIdByName(country),
                        this.getColorIdByName(this.formModel.playerSlots[slotIndex].color),
                        this.formModel.playerSlots[slotIndex].startPos,
                        this.formModel.playerSlots[slotIndex].team,
                        slotIndex,
                    );
                    this.updateFormModel();
                }
            },
            onColorSelect: (color: any, slotIndex: number) => {
                if (this.wolCon.isOpen() && this.gameChannelName) {
                    this.sendPlayerInfo(
                        this.getCountryIdByName(this.formModel.playerSlots[slotIndex].country),
                        this.getColorIdByName(color),
                        this.formModel.playerSlots[slotIndex].startPos,
                        this.formModel.playerSlots[slotIndex].team,
                        slotIndex,
                    );
                    this.updateFormModel();
                }
            },
            onStartPosSelect: (startPos: any, slotIndex: number) => {
                if (this.wolCon.isOpen() && this.gameChannelName) {
                    this.sendPlayerInfo(
                        this.getCountryIdByName(this.formModel.playerSlots[slotIndex].country),
                        this.getColorIdByName(this.formModel.playerSlots[slotIndex].color),
                        startPos,
                        this.formModel.playerSlots[slotIndex].team,
                        slotIndex,
                    );
                    this.updateFormModel();
                }
            },
            onTeamSelect: (team: any, slotIndex: number) => {
                if (this.wolCon.isOpen() && this.gameChannelName) {
                    this.sendPlayerInfo(
                        this.getCountryIdByName(this.formModel.playerSlots[slotIndex].country),
                        this.getColorIdByName(this.formModel.playerSlots[slotIndex].color),
                        this.formModel.playerSlots[slotIndex].startPos,
                        team,
                        slotIndex,
                    );
                    this.updateFormModel();
                }
            },
            onSlotChange: (occupation: number, slotIndex: number, aiDifficulty?: any) => {
                if (this.wolCon.isOpen() && this.gameChannelName) {
                    this.changeSlotType(occupation, slotIndex, aiDifficulty);
                }
            },
            onToggleShortGame: (checked: boolean) => this.applyGameOption((options) => (options.shortGame = checked)),
            onToggleMcvRepacks: (checked: boolean) => this.applyGameOption((options) => (options.mcvRepacks = checked)),
            onToggleCratesAppear: (checked: boolean) => this.applyGameOption((options) => (options.cratesAppear = checked)),
            onToggleSuperWeapons: (checked: boolean) => this.applyGameOption((options) => (options.superWeapons = checked)),
            onToggleBuildOffAlly: (checked: boolean) => this.applyGameOption((options) => (options.buildOffAlly = checked)),
            onToggleHostTeams: (checked: boolean) => this.applyGameOption((options) => (options.hostTeams = checked)),
            onToggleDestroyableBridges: (checked: boolean) => this.applyGameOption((options) => (options.destroyableBridges = checked)),
            onToggleMultiEngineer: (checked: boolean) => this.applyGameOption((options) => {
                options.multiEngineer = checked;
                if (checked) {
                    options.instantCapture = true;
                }
            }),
            onToggleNoDogEngiKills: (checked: boolean) => this.applyGameOption((options) => (options.noDogEngiKills = checked)),
            onToggleInstantCapture: (checked: boolean) => this.applyGameOption((options) => (options.instantCapture = checked)),
            onToggleDelayedOils: (checked: boolean) => this.applyGameOption((options) => (options.delayedOils = checked)),
            onChangeGameSpeed: (value: number) => this.applyGameOption((options) => (options.gameSpeed = value)),
            onChangeCredits: (value: number) => this.applyGameOption((options) => (options.credits = value)),
            onChangeUnitCount: (value: number) => this.applyGameOption((options) => (options.unitCount = value)),
            activeSlotIndex: -1,
            teamsAllowed: true,
            teamsRequired: false,
            playerSlots: [],
            shortGame: true,
            mcvRepacks: true,
            cratesAppear: true,
            superWeapons: true,
            buildOffAlly: true,
            hostTeams: false,
            destroyableBridges: true,
            multiEngineer: false,
            multiEngineerCount: Math.ceil((1 - this.rules.general.engineerCaptureLevel) / this.rules.general.engineerDamage) + 1,
            noDogEngiKills: false,
            instantCapture: true,
            delayedOils: false,
            gameSpeed: 6,
            credits: mpDialogSettings.money,
            unitCount: mpDialogSettings.unitCount,
        };
        this.playerReadyStatus.clear();
        this.playerHasMapStatus.clear();
        this.messages.length = 0;
    }

    private applyGameOption(update: (options: GameOpts) => void): void {
        if (!this.hostMode) {
            throw new Error("Can't change options when not a host");
        }
        if (this.wolCon.isOpen()) {
            update(this.gameOpts!);
            GameOptSanitizer.sanitize(this.gameOpts, this.rules);
            this.updateFormModel();
            this.sendGameOpts();
            this.localPrefs.setItem(StorageKey.PreferredGameOpts, this.preferredHostOpts!.applyGameOpts(this.gameOpts!).serialize());
        }
        else {
            this.onWolClose();
        }
    }

    private changeSlotType(occupation: number, slotIndex: number, aiDifficulty?: any): void {
        if (!this.hostMode) {
            throw new Error("Only host can change slot type");
        }
        if (slotIndex === 0) {
            throw new Error("Change slot type of host");
        }
        const slotModel = this.formModel.playerSlots[slotIndex];
        const slot = this.slotsInfo![slotIndex];
        if (slotModel.occupation === occupation && slot.type === SlotType.Player && aiDifficulty === undefined) {
            return;
        }
        if (slotModel.occupation === SlotOccupation.Occupied) {
            if (slot.type === SlotType.Player) {
                this.kickPlayer(slot.name!);
            }
            else {
                this.gameOpts!.aiPlayers[slotIndex] = undefined;
            }
        }
        const mpDialogSettings = this.gameModes.getById(this.gameOpts!.gameMode).mpDialogSettings;
        if (occupation === SlotOccupation.Closed) {
            slot.type = SlotType.Closed;
            this.preferredHostOpts!.slotsClosed.add(slotIndex);
        }
        else if (occupation === SlotOccupation.Open) {
            slot.type = slotIndex === this.observerSlotIndex ? SlotType.OpenObserver : SlotType.Open;
            this.preferredHostOpts!.slotsClosed.delete(slotIndex);
        }
        else if (occupation === SlotOccupation.Occupied && aiDifficulty !== undefined) {
            slot.type = SlotType.Ai;
            slot.difficulty = aiDifficulty;
            this.gameOpts!.aiPlayers[slotIndex] = {
                difficulty: aiDifficulty,
                countryId: RANDOM_COUNTRY_ID,
                colorId: RANDOM_COLOR_ID,
                startPos: RANDOM_START_POS,
                teamId: mpDialogSettings.mustAlly ? 3 : NO_TEAM_ID,
            };
            this.preferredHostOpts!.slotsClosed.delete(slotIndex);
        }
        this.updateFormModel();
        this.sendGameSlotInfo();
        this.sendGameOpts();
        this.sendModeMaxSlots();
        this.localPrefs.setItem(StorageKey.PreferredGameOpts, this.preferredHostOpts!.serialize());
    }

    private getCountryNameById(countryId: number): string {
        let name: string;
        if (countryId === RANDOM_COUNTRY_ID) {
            name = RANDOM_COUNTRY_NAME;
        }
        else if (countryId === OBS_COUNTRY_ID) {
            name = OBS_COUNTRY_NAME;
        }
        else {
            name = this.getAvailablePlayerCountries()[countryId];
        }
        return name;
    }

    private getCountryIdByName(countryName: string): number {
        let countryId: number;
        if (countryName === RANDOM_COUNTRY_NAME) {
            countryId = RANDOM_COUNTRY_ID;
        }
        else if (countryName === OBS_COUNTRY_NAME) {
            countryId = OBS_COUNTRY_ID;
        }
        else {
            countryId = this.getAvailablePlayerCountries().indexOf(countryName);
        }
        return countryId;
    }

    private getColorNameById(colorId: number): string {
        let name: string;
        if (colorId === RANDOM_COLOR_ID) {
            name = RANDOM_COLOR_NAME;
        }
        else {
            name = this.getAvailablePlayerColors()[colorId];
        }
        return name;
    }

    private getColorIdByName(colorName: string): number {
        let colorId: number;
        if (colorName === RANDOM_COLOR_NAME) {
            colorId = RANDOM_COLOR_ID;
        }
        else {
            colorId = this.getAvailablePlayerColors().indexOf(colorName);
            if (colorId === -1) {
                throw new Error(`Color ${colorName} not found in available player colors`);
            }
        }
        return colorId;
    }

    private sendPlayerInfo(countryId: number, colorId: number, startPos: number, teamId: number, slotIndex?: number): void {
        if (!this.hostPlayerName) {
            throw new Error("Host player name not yet set.");
        }
        if (this.hostMode) {
            if (slotIndex !== undefined && slotIndex !== this.formModel.activeSlotIndex) {
                const slot = this.slotsInfo![slotIndex];
                if (slot.type !== SlotType.Ai && !this.gameOpts!.hostTeams) {
                    throw new Error("Can't change country and color for a non-AI slot");
                }
                let playerInfo = this.gameOpts!.aiPlayers[slotIndex];
                if (!playerInfo) {
                    if (!this.gameOpts!.hostTeams) {
                        throw new Error("No AI found in slot " + slotIndex);
                    }
                    if (slot.type !== SlotType.Player) {
                        console.warn(`Can't change player info for ${SlotType[slot.type]} slot at ` + slotIndex);
                        return;
                    }
                    playerInfo = this.gameOpts!.humanPlayers.find((player) => player.name === slot.name) as any;
                }
                if (!playerInfo) {
                    throw new Error("No human player found in slot " + slotIndex);
                }
                playerInfo.countryId = countryId;
                playerInfo.colorId = colorId;
                playerInfo.startPos = startPos;
                playerInfo.teamId = teamId;
            }
            else {
                this.updatePlayerInfo(this.hostPlayerName, countryId, colorId, startPos, teamId);
            }
            this.updateFormModel();
            this.sendGameOpts();
        }
        else {
            this.wolCon.sendPlayerOpts(this.hostPlayerName, countryId, colorId, startPos, teamId);
        }
        if (slotIndex === undefined || slotIndex === this.formModel.activeSlotIndex) {
            if (countryId !== OBS_COUNTRY_ID) {
                if (countryId !== RANDOM_COUNTRY_ID) {
                    this.localPrefs.setItem(StorageKey.LastPlayerCountry, String(countryId));
                }
                else {
                    this.localPrefs.removeItem(StorageKey.LastPlayerCountry);
                }
                if (colorId !== RANDOM_COLOR_ID) {
                    this.localPrefs.setItem(StorageKey.LastPlayerColor, String(colorId));
                }
                else {
                    this.localPrefs.removeItem(StorageKey.LastPlayerColor);
                }
            }
        }
    }

    private updatePlayerInfo(playerName: string, countryId: number, colorId: number, startPos: number, teamId: number, preservePositions: boolean = false): void {
        if (!this.hostMode) {
            throw new Error("Method should only be used in host mode");
        }
        const playerInfo = this.gameOpts!.humanPlayers.find((player) => player.name === playerName);
        if (playerInfo) {
            playerInfo.countryId = countryId;
            playerInfo.colorId = colorId;
            if (!preservePositions) {
                playerInfo.startPos = startPos;
                playerInfo.teamId = teamId;
            }
        }
        else {
            console.error("Can't set country/color for non-existent player " + playerName);
        }
    }

    private updateFormModel(): void {
        const gameOpts = this.gameOpts;
        if (gameOpts) {
            this.formModel.gameSpeed = gameOpts.gameSpeed;
            this.formModel.credits = gameOpts.credits;
            this.formModel.unitCount = gameOpts.unitCount;
            this.formModel.shortGame = gameOpts.shortGame;
            this.formModel.superWeapons = gameOpts.superWeapons;
            this.formModel.buildOffAlly = gameOpts.buildOffAlly;
            this.formModel.hostTeams = gameOpts.hostTeams ?? false;
            this.formModel.mcvRepacks = gameOpts.mcvRepacks;
            this.formModel.cratesAppear = gameOpts.cratesAppear;
            this.formModel.destroyableBridges = gameOpts.destroyableBridges;
            this.formModel.multiEngineer = gameOpts.multiEngineer;
            this.formModel.noDogEngiKills = gameOpts.noDogEngiKills;
            this.formModel.instantCapture = gameOpts.instantCapture;
            this.formModel.delayedOils = gameOpts.delayedOils;
        }
        if (this.gameOpts && this.slotsInfo) {
            let maxSlotsRemaining = this.gameOpts.maxSlots;
            this.slotsInfo.forEach((slot, slotIndex) => {
                if (slotIndex !== this.observerSlotIndex) {
                    if (maxSlotsRemaining) {
                        maxSlotsRemaining--;
                        this.formModel.playerSlots[slotIndex] = {
                            country: RANDOM_COUNTRY_NAME,
                            color: RANDOM_COLOR_NAME,
                            startPos: RANDOM_START_POS,
                            team: NO_TEAM_ID,
                        };
                    }
                    else {
                        this.formModel.playerSlots[slotIndex] = undefined;
                    }
                }
                else {
                    this.formModel.playerSlots[slotIndex] = {
                        country: RANDOM_COUNTRY_NAME,
                        color: RANDOM_COLOR_NAME,
                        startPos: RANDOM_START_POS,
                        team: NO_TEAM_ID,
                    };
                }
            });
            this.slotsInfo.forEach((slot, slotIndex) => {
                const slotModel = this.formModel.playerSlots[slotIndex];
                if (slotModel) {
                    if (slot.type === SlotType.Closed) {
                        slotModel.occupation = SlotOccupation.Closed;
                    }
                    else if (slot.type === SlotType.Open || slot.type === SlotType.OpenObserver) {
                        slotModel.occupation = SlotOccupation.Open;
                    }
                    else {
                        slotModel.occupation = SlotOccupation.Occupied;
                    }
                    if (slot.type === SlotType.OpenObserver || slotIndex === this.observerSlotIndex) {
                        slotModel.type = ViewModelSlotType.Observer;
                    }
                    else if (slot.type === SlotType.Ai) {
                        slotModel.type = ViewModelSlotType.Ai;
                    }
                    else {
                        slotModel.type = ViewModelSlotType.Player;
                    }
                    if (slot.type === SlotType.Ai) {
                        slotModel.aiDifficulty = slot.difficulty;
                        slotModel.status = PlayerStatus.Ready;
                    }
                    else if (slot.type === SlotType.Player) {
                        slotModel.name = slot.name;
                        if (slot.name === this.hostPlayerName) {
                            slotModel.status = PlayerStatus.Host;
                        }
                        else {
                            slotModel.status = this.playerReadyStatus.get(slot.name!) ? PlayerStatus.Ready : PlayerStatus.NotReady;
                        }
                    }
                }
            });
        }
        const humanPlayers = this.gameOpts ? this.gameOpts.humanPlayers : [];
        const aiPlayers = this.gameOpts ? this.gameOpts.aiPlayers : [];
        const mpDialogSettings = this.gameOpts ? this.gameModes.getById(this.gameOpts.gameMode).mpDialogSettings : undefined;
        this.formModel.playerSlots.forEach((slotModel, slotIndex) => {
            if (slotModel && humanPlayers.length) {
                if (slotModel.occupation === SlotOccupation.Occupied) {
                    const humanPlayer = humanPlayers.find((player) => player.name === slotModel.name);
                    if (humanPlayer) {
                        slotModel.country = this.getCountryNameById(humanPlayer.countryId);
                        slotModel.color = this.getColorNameById(humanPlayer.colorId);
                        slotModel.startPos = humanPlayer.startPos;
                        slotModel.team = humanPlayer.teamId;
                    }
                    else {
                        const aiPlayer = aiPlayers[slotIndex];
                        if (aiPlayer) {
                            slotModel.country = this.getCountryNameById(aiPlayer.countryId);
                            slotModel.color = this.getColorNameById(aiPlayer.colorId);
                            slotModel.startPos = aiPlayer.startPos;
                            slotModel.team = aiPlayer.teamId;
                        }
                    }
                    const ping = this.playerPings.find((playerPing) => !!slotModel.name && playerPing.playerName === slotModel.name);
                    if (ping) {
                        slotModel.ping = ping.ping > 0 ? ping.ping : undefined;
                    }
                    if (this.playerProfiles && slotModel.type === ViewModelSlotType.Player) {
                        slotModel.playerProfile = this.playerProfiles.get(slotModel.name);
                    }
                }
                else if (slotIndex === this.observerSlotIndex) {
                    slotModel.country = OBS_COUNTRY_NAME;
                }
                else {
                    slotModel.country = RANDOM_COUNTRY_NAME;
                    if (mpDialogSettings) {
                        slotModel.team = mpDialogSettings.mustAlly ? 3 : NO_TEAM_ID;
                    }
                }
            }
        });
        if (!this.hostMode) {
            this.formModel.activeSlotIndex = this.slotsInfo
                ? this.slotsInfo.findIndex((slot) => slot.type === SlotType.Player && slot.name === this.wolCon.getCurrentUser())
                : -1;
        }
        this.formModel.availablePlayerColors = this.getSelectablePlayerColors();
        this.formModel.availableStartPositions = this.getSelectableStartPositions();
        if (this.gameOpts) {
            this.formModel.teamsAllowed = this.gameModes.getById(this.gameOpts.gameMode).mpDialogSettings.alliesAllowed;
            this.formModel.teamsRequired = this.gameModes.getById(this.gameOpts.gameMode).mpDialogSettings.mustAlly;
        }
        if (this.lobbyForm && humanPlayers.length) {
            this.lobbyForm.refresh();
        }
    }

    private addSystemMessage(text: string, untrustedContent: boolean = false): void {
        if (this.lobbyForm) {
            this.messages.push({ text, untrustedContent });
            this.lobbyForm.refresh();
        }
    }

    private setStartGamePending(pending: boolean): void {
        if (this.startGamePending === pending) {
            return;
        }
        this.startGamePending = pending;
        if (this.lobbyForm) {
            this.refreshSidebarButtons();
        }
        if (pending) {
            this.messageBoxApi.show(this.strings.get("wol:matchgamestarting"));
        }
        else if (this.wolService.isConnected()) {
            this.messageBoxApi.destroy();
        }
    }

    private sendGameOptsNow(): void {
        if (!this.hostMode) {
            throw new Error("Should only be used in host mode");
        }
        if (this.gameOpts && this.wolCon.isOpen() && this.gameChannelName) {
            this.gameOpts.humanPlayers.forEach((player) => {
                if (player.colorId === -1) {
                    player.colorId = RANDOM_COLOR_ID;
                }
            });
            const serializedOpts = this.gameOptSerializer.serializeOptions(this.gameOpts);
            this.wolCon.sendGameOpts(serializedOpts);
            const maxPlayers = this.slotsInfo!.filter((slot) => slot.type === SlotType.Ai || slot.type === SlotType.Player || slot.type === SlotType.Open || slot.type === SlotType.OpenObserver).length;
            const minPlayers = this.slotsInfo!.filter((slot) => slot.type === SlotType.Player).length;
            const modName = this.activeModMeta
                ? this.activeModMeta.name + (this.activeModMeta.version !== undefined ? ` (${this.activeModMeta.version})` : "")
                : undefined;
            this.wolCon.sendGameTopic({
                description: this.hostRoomDesc,
                engineVersion: this.engineVersion,
                modHash: this.engineModHash,
                modName,
                aiPlayers: this.gameOpts.aiPlayers.filter((player) => !!player).length,
                observers: Number(this.slotsInfo![this.observerSlotIndex].type === SlotType.Player),
                observable: this.slotsInfo![this.observerSlotIndex].type === SlotType.OpenObserver,
                minPlayers,
                maxPlayers,
                mapName: this.gameOpts.mapName,
            });
            this.sendPingData();
        }
    }

    private handlePlayerJoinLeave(event: any): void {
        if (!this.hostMode) {
            throw new Error("Should only be used in host mode");
        }
        if (this.wolCon.isOpen() && this.gameChannelName && this.slotsInfo) {
            if (event.type === "join") {
                let slotIndex: number;
                let isObserver: boolean;
                if (event.user.observer === undefined) {
                    slotIndex = this.slotsInfo.findIndex((slot) => slot.type === SlotType.Open);
                    isObserver = slotIndex === -1;
                    if (isObserver) {
                        slotIndex = this.slotsInfo.findIndex((slot) => slot.type === SlotType.OpenObserver);
                    }
                }
                else {
                    isObserver = event.user.observer;
                    slotIndex = this.slotsInfo.findIndex((slot) => slot.type === (isObserver ? SlotType.OpenObserver : SlotType.Open));
                }
                if (slotIndex === -1) {
                    this.kickPlayer(event.user.name);
                    return;
                }
                this.slotsInfo[slotIndex] = {
                    type: SlotType.Player,
                    name: event.user.name,
                };
                const mpDialogSettings = this.gameModes.getById(this.gameOpts!.gameMode).mpDialogSettings;
                this.gameOpts!.humanPlayers.push({
                    name: event.user.name,
                    countryId: isObserver ? OBS_COUNTRY_ID : RANDOM_COUNTRY_ID,
                    colorId: isObserver ? OBS_COLOR_ID : RANDOM_COLOR_ID,
                    startPos: RANDOM_START_POS,
                    teamId: mpDialogSettings.mustAlly ? 0 : NO_TEAM_ID,
                });
                this.playerReadyStatus.set(event.user.name, false);
                for (const playerName of this.playerReadyStatus.keys()) {
                    this.playerReadyStatus.set(playerName, false);
                }
            }
            else {
                this.removeHumanPlayer(event.user.name);
            }
            this.sendGameSlotInfo();
            this.sendObserverSlotInfo();
            this.sendGameOpts();
        }
    }

    private removeHumanPlayer(playerName: string): void {
        let slotIndex = this.slotsInfo!.findIndex((slot) => slot.type === SlotType.Player && slot.name === playerName);
        if (slotIndex !== -1) {
            const slot = this.slotsInfo![slotIndex];
            if (slotIndex === this.observerSlotIndex) {
                slot.type = SlotType.OpenObserver;
            }
            else {
                slot.type = SlotType.Open;
            }
        }
        slotIndex = this.gameOpts!.humanPlayers.findIndex((player) => player.name === playerName);
        if (slotIndex !== -1) {
            this.gameOpts!.humanPlayers.splice(slotIndex, 1);
        }
        this.playerReadyStatus.delete(playerName);
        this.playerHasMapStatus.delete(playerName);
        slotIndex = this.playerPings.findIndex((ping) => ping.playerName === playerName);
        if (slotIndex !== -1) {
            this.playerPings.splice(slotIndex, 1);
        }
    }

    private kickPlayer(playerName: string, reason?: string): void {
        if (this.gameChannelName && this.wolCon.isInChannel(this.gameChannelName)) {
            this.wolCon.kick([playerName], this.gameChannelName, reason);
            this.removeHumanPlayer(playerName);
        }
    }

    private sendObserverSlotInfo(): void {
        this.wolCon.sendObserverSlot(String(this.observerSlotIndex));
    }

    private sendGameSlotInfoNow(): void {
        if (this.wolCon.isOpen() && this.gameChannelName) {
            const serializedSlots = this.gameOptSerializer.serializeSlotData(this.slotsInfo!);
            this.wolCon.sendGameSlotsInfo(serializedSlots);
        }
    }

    private sendPingData(): void {
        if (this.playerPings.length) {
            const serializedPings = this.gameOptSerializer.serializePingData(this.playerPings);
            this.wolCon.sendPingData(serializedPings);
        }
    }

    private sendModeMaxSlots(): void {
        if (!this.hostMode) {
            throw new Error("Must be in host mode");
        }
        if (!this.slotsInfo) {
            throw new Error("Slots info should be set by now");
        }
        const channelName = this.gameChannelName;
        if (!channelName || !this.wolCon.isInChannel(channelName)) {
            throw new Error("Must be in a game channel");
        }
        const maxPlayers = this.slotsInfo.filter((slot) => slot.type !== SlotType.Closed && slot.type !== SlotType.Ai).length;
        this.wolCon.sendModeChannelMax(channelName, maxPlayers);
    }

    private updatePlayerPing(playerName: string, ping: number): void {
        const existingPing = this.playerPings.find((playerPing) => playerPing.playerName === playerName);
        if (existingPing) {
            existingPing.ping = ping;
        }
        else {
            this.playerPings.push({ ping, playerName });
        }
    }

    private handlePlayerOptsChange(playerName: string, opt: string): void {
        const slotIndex = this.slotsInfo!.findIndex((slot) => slot.type === SlotType.Player && slot.name === playerName);
        if (slotIndex === -1) {
            return;
        }
        const [countryId, colorId, startPos, teamId] = opt.slice(1).split(",").map(Number);
        const playerInfo = this.gameOpts!.humanPlayers.find((player) => player.name === playerName)!;
        const safeColorId = this.getSelectablePlayerColors().includes(this.getColorNameById(colorId)) ? colorId : playerInfo.colorId;
        const safeStartPos = this.getSelectableStartPositions().includes(startPos) ? startPos : playerInfo.startPos;
        const mpDialogSettings = this.gameModes.getById(this.gameOpts!.gameMode).mpDialogSettings;
        const safeTeamId = !mpDialogSettings.alliesAllowed || (teamId === NO_TEAM_ID && mpDialogSettings.mustAlly)
            ? mpDialogSettings.mustAlly ? 0 : NO_TEAM_ID
            : teamId;
        if (countryId === OBS_COUNTRY_ID || slotIndex !== this.observerSlotIndex) {
            this.updatePlayerInfo(playerName, countryId, safeColorId, safeStartPos, safeTeamId, this.gameOpts!.hostTeams);
            this.sendGameOpts();
            if (countryId === OBS_COUNTRY_ID) {
                const observerSlot = this.slotsInfo![this.observerSlotIndex];
                if (observerSlot.type !== SlotType.OpenObserver) {
                    if (!(observerSlot.type === SlotType.Player && observerSlot.name === playerName)) {
                        console.warn(`Player ${playerName} tried to move to an unavailable observer slot`);
                        this.kickPlayer(playerName);
                    }
                }
                else {
                    this.slotsInfo![this.observerSlotIndex] = this.slotsInfo![slotIndex];
                    this.slotsInfo![slotIndex] = {
                        type: SlotType.Open,
                    };
                    this.sendGameSlotInfo();
                }
            }
        }
        else {
            this.kickPlayer(playerName);
        }
    }

    private handleGameOptReady(playerName: string, ready: string): void {
        if (this.slotsInfo) {
            const slotIndex = this.slotsInfo.findIndex((slot) => slot.type === SlotType.Player && slot.name === playerName);
            if (slotIndex === -1 && this.hostMode) {
                return;
            }
        }
        this.playerReadyStatus.set(playerName, Boolean(Number(ready)));
        if (!this.hostMode && playerName === this.wolCon.getCurrentUser()) {
            if (Number(ready)) {
                this.acceptButtonFlashing = false;
            }
            this.refreshSidebarButtons();
        }
        if (this.hostMode && ![...this.playerReadyStatus.values()].filter((status) => status === false).length) {
            this.sound.play(SoundKey.OptionsChanged, ChannelType.Ui);
        }
    }

    private handleGameOptHasMap(playerName: string, hasMap: string): void {
        if (this.slotsInfo) {
            const slotIndex = this.slotsInfo.findIndex((slot) => slot.type === SlotType.Player && slot.name === playerName);
            if (slotIndex === -1 && this.hostMode) {
                return;
            }
        }
        let status = Number(hasMap);
        if (![WolHasMapStatus.NoMap, WolHasMapStatus.HasMap, WolHasMapStatus.MapTransfer].includes(status)) {
            status = WolHasMapStatus.NoMap;
        }
        this.playerHasMapStatus.set(playerName, status as WolHasMapStatus);
        if (this.hostMode || playerName !== this.wolCon.getCurrentUser()) {
            if (status !== WolHasMapStatus.HasMap && this.gameOpts) {
                this.messages.push({
                    untrustedContent: true,
                    text: status === WolHasMapStatus.MapTransfer
                        ? this.strings.get("GUI:HostMapTransfer", playerName, `"${this.gameOpts.mapTitle}"`)
                        : this.strings.get("GUI:HostNoMap", playerName, `"${this.gameOpts.mapTitle}"`) +
                            (this.hostIsFreshAccount ? " " + this.strings.get("GUI:HostNoMapUpload") : ""),
                });
            }
        }
        else {
            this.refreshSidebarButtons();
        }
    }

    private handleGameOptObserver(opt: string): void {
        this.observerSlotIndex = Number(opt);
    }

    private handleGameOptSlots(opt: string): void {
        this.slotsInfo = this.gameOptParser.parseSlotData(opt);
    }

    private handleGameOptPing(opt: string): void {
        this.playerPings = this.gameOptParser.parsePingData(opt);
    }

    private handleGameOptOptions(opt: string): void {
        if (this.gameChannelName && this.wolCon.isInChannel(this.gameChannelName)) {
            const parsedOpts = this.gameOptParser.parseOptions(opt);
            const mapChanged = parsedOpts.mapName !== this.gameOpts?.mapName || parsedOpts.mapDigest !== this.gameOpts?.mapDigest;
            GameOptSanitizer.sanitize(parsedOpts, this.rules);
            this.gameOpts = parsedOpts;
            this.refreshSidebarMpText();
            if (mapChanged && this.wolCon.isOpen()) {
                const username = this.wolCon.getCurrentUser()!;
                this.playerReadyStatus.set(username, false);
                this.playerHasMapStatus.set(username, WolHasMapStatus.NoMap);
                this.refreshSidebarButtons();
                this.wolCon.sendPlayerReady(false);
                this.guestUpdateMapDeferred(parsedOpts);
            }
        }
    }

    private guestUpdateMapDeferred(gameOpts: GameOpts): void {
        this.mapLoadTask?.cancel();
        this.mapLoadTask = new Task(async (cancellationToken) => {
            this.controller.setSidebarPreview();
            this.currentMapFile = undefined;
            const mapFile = this.currentMapFile = await this.loadAndCheckMap(gameOpts);
            if (!cancellationToken.isCancelled() && this.wolCon.isOpen()) {
                const canTransfer = !!this.mapTransferService.getUrl() &&
                    !mapFile &&
                    !gameOpts.mapOfficial &&
                    !this.hostIsFreshAccount &&
                    gameOpts.mapSizeBytes <= MAX_MAP_TRANSFER_BYTES;
                const status = mapFile
                    ? WolHasMapStatus.HasMap
                    : canTransfer
                        ? WolHasMapStatus.MapTransfer
                        : WolHasMapStatus.NoMap;
                this.wolCon.sendPlayerHasMap(status);
                if (mapFile) {
                    this.updateMapPreview(mapFile);
                }
                else {
                    this.addSystemMessage(
                        canTransfer
                            ? this.strings.get("GUI:JoinerMapTransfer", `"${gameOpts.mapTitle}"`)
                            : this.hostIsFreshAccount
                                ? this.strings.get("GUI:HostNoMapUpload")
                                : this.strings.get("GUI:JoinerNoMap", `"${gameOpts.mapTitle}"`),
                        true,
                    );
                }
                this.refreshSidebarMpText();
            }
        });
        this.mapLoadTask.start().catch((error) => {
            if (!(error instanceof OperationCanceledError)) {
                this.handleError(error, this.strings.get("TXT_DOWNLOAD_FAILED"));
            }
        });
    }

    private updateMapPreview(mapFile?: VirtualFile): void {
        try {
            const preview = new MapPreviewRenderer(this.strings).render(
                new MapFile(mapFile),
                this.hostMode ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
                this.controller.getSidebarPreviewSize(),
            );
            this.controller.setSidebarPreview(preview);
        }
        catch (error) {
            console.error("Failed to render map preview");
            console.error(error);
            this.controller.setSidebarPreview();
        }
    }

    private async loadAndCheckMap(gameOpts: GameOpts): Promise<VirtualFile | undefined> {
        if (this.mapList.getByName(gameOpts.mapName)) {
            const mapFile = await this.mapFileLoader.load(gameOpts.mapName);
            return MapDigest.compute(mapFile) === gameOpts.mapDigest && mapFile.getSize() === gameOpts.mapSizeBytes
                ? mapFile
                : undefined;
        }
        return undefined;
    }

    private initLobbyForm(): void {
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            innerRef: (ref: any) => (this.lobbyForm = ref),
            component: LobbyForm,
            props: this.formModel,
        }));
        this.controller.setMainComponent(component);
    }

    private refreshSidebarButtons(): void {
        const strings = this.strings;
        const isReady = this.playerReadyStatus.get(this.wolCon.getCurrentUser()!);
        const hasMapStatus = this.playerHasMapStatus.get(this.wolCon.getCurrentUser()!) ?? WolHasMapStatus.NoMap;
        const buttons = [
            ...(this.hostMode
                ? [{
                    label: strings.get("GUI:StartGame"),
                    tooltip: strings.get("STT:HostButtonGo"),
                    disabled: this.startGamePending,
                    onClick: () => {
                        if (this.startGamePending || !this.wolCon.isOpen()) {
                            return;
                        }
                        const noMapPlayer = [...this.playerHasMapStatus.entries()].find(([, status]) => status === WolHasMapStatus.NoMap)?.[0];
                        if (noMapPlayer !== undefined) {
                            this.addSystemMessage(
                                this.strings.get("GUI:HostNoMap", noMapPlayer, `"${this.gameOpts!.mapTitle}"`) +
                                    (this.hostIsFreshAccount ? " " + this.strings.get("GUI:HostNoMapUpload") : ""),
                                true,
                            );
                        }
                        else if (this.gameOpts!.humanPlayers.filter((player) => player.countryId !== OBS_COUNTRY_ID).length < 2) {
                            this.addSystemMessage(this.strings.get("TXT_ONLY_ONE"));
                        }
                        else if (this.meetsMinimumTeams()) {
                            if ([...this.playerReadyStatus.values()].filter((status) => status === false).length) {
                                this.addSystemMessage(this.strings.get("GUI:HostGameStartHost"));
                                this.wolCon.sendGameStartRequest();
                            }
                            else {
                                this.sendGameOptsNow();
                                this.wolCon.startGame(this.gameOpts!.humanPlayers.map((player) => player.name));
                                this.setStartGamePending(true);
                            }
                        }
                        else {
                            this.addSystemMessage(this.strings.get("TXT_CANNOT_ALLY"));
                        }
                    },
                }]
                : [{
                    label: isReady ? strings.get("GUI:NotReady") : strings.get("GUI:Accept"),
                    tooltip: isReady ? strings.get("STT:NotReady") : strings.get("STT:GuestButtonAccept"),
                    disabled: hasMapStatus === WolHasMapStatus.NoMap,
                    flashing: !isReady && this.acceptButtonFlashing,
                    onClick: () => {
                        if (this.wolCon.isOpen() && this.gameChannelName) {
                            this.playerReadyStatus.set(this.wolCon.getCurrentUser()!, !isReady);
                            this.wolCon.sendPlayerReady(!isReady);
                        }
                    },
                }]),
            ...(this.hostMode
                ? [{
                    label: strings.get("GUI:ChooseMap"),
                    tooltip: strings.get("STT:HostButtonChooseMap"),
                    onClick: () => {
                        this.controller?.pushScreen(ScreenType.MapSelection, {
                            lobbyType: this.hostMode ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
                            gameOpts: this.gameOpts,
                            usedSlots: () => 1 +
                                findIndexReverse(this.slotsInfo!, (slot, slotIndex) =>
                                    slot.type === SlotType.Ai ||
                                    (slot.type === SlotType.Player && this.observerSlotIndex !== slotIndex)) -
                                (this.observerSlotIndex === 0 ? 1 : 0),
                        });
                    },
                }]
                : []),
            {
                label: strings.get("GUI:Back"),
                tooltip: this.hostMode ? strings.get("STT:HostButtonBack") : strings.get("STT:GuestButtonBack"),
                isBottom: true,
                onClick: () => {
                    this.controller?.goToScreen(ScreenType.CustomGame as any, {});
                },
            },
        ];
        this.controller.setSidebarButtons(buttons, true);
        this.refreshSidebarMpText();
    }

    private meetsMinimumTeams(): boolean {
        const players = [...this.gameOpts!.humanPlayers, ...this.gameOpts!.aiPlayers]
            .filter(isNotNullOrUndefined)
            .filter((player) => player.countryId !== OBS_COUNTRY_ID);
        const firstTeamId = players[0].teamId;
        return firstTeamId === NO_TEAM_ID || players.some((player) => player.teamId !== firstTeamId);
    }

    private refreshSidebarMpText(): void {
        if (this.gameOpts) {
            this.controller.setSidebarMpContent({
                text: this.strings.get(this.gameModes.getById(this.gameOpts.gameMode).label) +
                    "\n\n" +
                    (this.hostMode || !this.hostIsFreshAccount || this.currentMapFile
                        ? this.gameOpts.mapTitle
                        : this.strings.get("GUI:CustomMap")),
                icon: this.gameOpts.mapOfficial ? "gt18.pcx" : "settings.png",
                tooltip: this.gameOpts.mapOfficial ? this.strings.get("STT:VerifiedMap") : this.strings.get("STT:UnverifiedMap"),
            });
        }
        else {
            this.controller.setSidebarMpContent({ text: "" });
        }
    }

    async onLeave(): Promise<void> {
        if (this.wolCon.isOpen() && this.wolCon.getCurrentUser() && this.gameChannelName) {
            this.wolCon.leaveChannel(this.gameChannelName);
        }
        this.disposables.dispose();
        this.mapLoadTask?.cancel();
        this.mapLoadTask = undefined;
        this.ranksUpdateTask?.cancel();
        this.ranksUpdateTask = undefined;
        this.pingsUpdateTask?.cancel();
        this.pingsUpdateTask = undefined;
        this.gservPingUpdateTask?.cancel();
        this.gservPingUpdateTask = undefined;
        this.currentMapFile = undefined;
        this.gameChannelName = undefined;
        this.hostPlayerName = undefined;
        this.hostIsFreshAccount = undefined;
        this.hostRoomDesc = "";
        this.gameOpts = undefined;
        this.preferredHostOpts = undefined;
        this.playerPings = undefined as any;
        this.slotsInfo = undefined;
        this.playerProfiles.clear();
        this.currentGameServer = undefined;
        this.acceptButtonFlashing = false;
        if (this.startGamePending) {
            this.startGamePending = false;
            this.messageBoxApi.destroy();
        }
        if (this.hostOptsIntervalId) {
            clearInterval(this.hostOptsIntervalId);
        }
        if (this.gservPingIntervalId) {
            clearInterval(this.gservPingIntervalId);
        }
        this.wolCon.onGameOpt.unsubscribe(this.handleGameOpt);
        this.wolCon.onGameStart.unsubscribe(this.handleGameStart);
        this.wolCon.onGameStartAbort.unsubscribe(this.handleGameStartAbort);
        this.wolCon.onGameServer.unsubscribe(this.handleGameServer);
        this.wolCon.onLeaveChannel.unsubscribe(this.onChannelLeave);
        this.wolCon.onJoinGameChannel.unsubscribe(this.onChannelJoin);
        this.wolCon.onChatMessage.unsubscribe(this.onChannelMessage);
        this.wolCon.onClose.unsubscribe(this.onWolClose);
        this.wolCon.onPartyUpdate.unsubscribe(this.handlePartyUpdate);
        this.wolService.onWolConnectionLost.unsubscribe(this.onWolConLost);
        this.controller.toggleSidebarPreview(false);
        await this.unrender();
    }

    private async unrender(): Promise<void> {
        await this.controller.hideSidebarButtons();
        if (this.lobbyForm) {
            this.lobbyForm = undefined;
        }
    }
}
