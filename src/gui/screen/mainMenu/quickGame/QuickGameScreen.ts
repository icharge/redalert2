import { Task } from "@puzzl/core/lib/async/Task";
import { CancellationToken, CancellationTokenSource, OperationCanceledError } from "@puzzl/core/lib/async/cancellation";
import { jsx } from "@/gui/jsx/jsx";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { MusicType } from "@/engine/sound/Music";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { ScreenType } from "@/gui/screen/mainMenu/ScreenType";
import { CompositeDisposable } from "@/util/disposable/CompositeDisposable";
import { RANDOM_COUNTRY_ID, RANDOM_COLOR_ID, RANDOM_COUNTRY_NAME, RANDOM_COUNTRY_UI_NAME, RANDOM_COUNTRY_UI_TOOLTIP, RANDOM_COLOR_NAME } from "@/game/gameopts/constants";
import { SoundKey } from "@/engine/sound/SoundKey";
import { ChannelType } from "@/engine/sound/ChannelType";
import { MainMenuRoute } from "@/gui/screen/mainMenu/MainMenuRoute";
import { QuickGameForm } from "@/gui/screen/mainMenu/quickGame/component/QuickGameForm";
import { LocalPrefs, StorageKey } from "@/LocalPrefs";
import { WLadderService } from "@/network/ladder/WLadderService";
import { LadderQueueType, getLadderTypeForQueueType, teamSizes } from "@/network/ladder/wladderConfig";
import { WolError } from "@/network/WolError";
import { REQ_MATCH, REQ_STATS, REQ_LIST_QUEUES, RPL_WORKING, RPL_STATS, RPL_QUEUE_LIST, RPL_BAD_VERS, RPL_BAD_HASH, RPL_MODE_UNAVAIL, RPL_RATE_LIMITED, RPL_MATCHED, RPL_REQUEUE, RPL_REMOVED_FROM_QUEUE, TAG_COUNTRY, TAG_COLOR, TAG_RANKED, TAG_VERSION, TAG_MODHASH } from "@/network/qmCodes";
import * as PartyCode from "@/network/partyCodes";
import { ChatUi } from "@/gui/screen/mainMenu/quickGame/ChatUi";
import { PartyStatus, getInitialPartyState, PartyState } from "@/gui/screen/mainMenu/quickGame/PartyState";
import { PartyInviteDialog } from "@/gui/component/PartyInviteDialog";
import { SendPartyInviteDialog } from "@/gui/component/SendPartyInviteDialog";
import { SessionService } from "@/network/SessionService";
import { WolConnection, WolChannelEvent, WolGameStartEvent } from "@/network/WolConnection";
import { WolService } from "@/network/WolService";
import { WolConfig } from "@/network/WolConfig";
import { RootController } from "@/gui/screen/RootController";

enum QueueState {
    None = 0,
    Initializing = 1,
    WaitingForMatch = 2,
    WaitingForStartTimer = 3,
    WaitingForGameStart = 4
}
interface QueueOptions {
    type: LadderQueueType;
    ranked: boolean;
    countryId: number;
    colorId: number;
}
interface QuickGameScreenParams {
    messages: any[];
}
interface CountryInfo {
    name: string;
    uiName: string;
    uiTooltip?: string;
}
interface Rules {
    getMultiplayerCountries(): CountryInfo[];
    getMultiplayerColors(): Map<string, {
        asHexString(): string;
    }>;
}
interface MessageBoxApi {
    show(message: string, buttonText?: string, onClose?: () => void): void;
    destroy(): void;
}
interface ErrorHandler {
    handle(error: any, message: string, onClose: () => void): void;
}
interface Sound {
    play(key: SoundKey, channel: ChannelType): void;
}
interface PendingInvite {
    from: string;
    timeoutId: number;
}
export class QuickGameScreen extends MainMenuScreen {
    private unrankedEnabled: boolean;
    private engineVersion: string;
    private engineModHash: string;
    private clientLocale: string;
    private rules: Rules;
    private wolService: WolService;
    private wolCon: WolConnection;
    private wladderService: WLadderService;
    declare private serverRegions: any;
    private rootController: RootController;
    private messageBoxApi: MessageBoxApi;
    private jsxRenderer: any;
    private strings: any;
    private localPrefs: LocalPrefs;
    private sound: Sound;
    private errorHandler: ErrorHandler;
    private sessionService: SessionService;
    private recentQmPlayers: {
        name: string;
        rankType: any;
    }[] = [];
    private partySize: number = 1;
    private partyState: PartyState = getInitialPartyState();
    private userHasDeclinedInvitesFrom: Set<string> = new Set();
    private availableQueueTypes: LadderQueueType[] = Object.values(LadderQueueType);
    private playButtonFlashing: boolean = false;
    private noInvites: boolean = false;
    private disposables: CompositeDisposable = new CompositeDisposable();
    private queueState: QueueState = QueueState.None;
    private queueOpts!: QueueOptions;
    private playerProfile?: any;
    private wolConfig?: WolConfig;
    private chatUi?: ChatUi;
    private form?: any;
    private quickMatchChannelName?: string;
    private countdownSeconds?: number;
    private countdownIntervalId?: number;
    private gameStartTimeoutId?: number;
    private updateStatsIntervalId?: number;
    private refreshProfileTask?: Task<void>;
    private prePartyQueueType?: LadderQueueType;
    private pendingInvite?: PendingInvite;
    private inviteDialog?: any;

    private get uiScene(): any {
        return (this.messageBoxApi as any).uiScene;
    }

    constructor(unrankedEnabled: boolean, engineVersion: string, engineModHash: string, clientLocale: string, rules: Rules, wolService: WolService, wolCon: WolConnection, wladderService: WLadderService, serverRegions: any, rootController: RootController, messageBoxApi: MessageBoxApi, jsxRenderer: any, strings: any, localPrefs: LocalPrefs, sound: Sound, errorHandler: ErrorHandler) {
        super();
        this.unrankedEnabled = unrankedEnabled;
        this.engineVersion = engineVersion;
        this.engineModHash = engineModHash;
        this.clientLocale = clientLocale;
        this.rules = rules;
        this.wolService = wolService;
        this.wolCon = wolCon;
        this.wladderService = wladderService;
        this.serverRegions = serverRegions;
        this.rootController = rootController;
        this.messageBoxApi = messageBoxApi;
        this.jsxRenderer = jsxRenderer;
        this.strings = strings;
        this.localPrefs = localPrefs;
        this.sound = sound;
        this.errorHandler = errorHandler;
        this.sessionService = new SessionService(wolService);
        this.title = this.strings.get("GUI:WolMatch");
        this.musicType = MusicType.NormalShuffle;
        this.invitePlayerPrompt = () => {
            const users = this.chatUi?.users ?? [];
            const recentPlayers = this.recentQmPlayers.filter(player => users.some(user => user.name === player.name));
            const [inviteDialog] = this.jsxRenderer.render(jsx(HtmlView, {
                component: SendPartyInviteDialog,
                props: {
                    strings: this.strings,
                    viewport: this.uiScene.viewport,
                    recentPlayers: recentPlayers,
                    onSubmit: (playerName: string) => {
                        inviteDialog.destroy();
                        this.wolCon.partyInvite(playerName);
                    },
                    onDismiss: () => {
                        inviteDialog.destroy();
                    },
                },
            }));
            this.uiScene.add(inviteDialog);
            this.disposables.add(inviteDialog, () => this.uiScene.remove(inviteDialog));
        };
        this.handleChatMessage = (message: any) => {
            if (message.text.startsWith(RPL_QUEUE_LIST + " ") && this.queueState === QueueState.None) {
                const queueListText = message.text.split(" ").slice(1).join(" ");
                const availableTypes = queueListText
                    .split(",")
                    .filter((type: string) => Object.values(LadderQueueType).includes(type as LadderQueueType)) as LadderQueueType[];
                this.availableQueueTypes = availableTypes;
                if (!availableTypes.includes(this.queueOpts.type) && availableTypes.length) {
                    this.queueOpts.type = availableTypes[0];
                    if (this.form) {
                        this.requestPlayerProfileRefresh();
                    }
                }
                this.form?.applyOptions((options: any) => {
                    options.enabledTypes = availableTypes;
                    options.type = this.queueOpts.type;
                });
            }
            if (this.queueState !== QueueState.None && message.from === this.wolConfig.getQuickMatchBotName()) {
                if ([RPL_WORKING, RPL_BAD_VERS, RPL_BAD_HASH, RPL_MODE_UNAVAIL, RPL_RATE_LIMITED].includes(message.text)) {
                    if (this.queueState === QueueState.Initializing) {
                        if (message.text === RPL_WORKING) {
                            this.updateQueueState(QueueState.WaitingForMatch);
                        }
                        else {
                            let errorMessage: string;
                            let isFatal = true;
                            if (message.text === RPL_BAD_VERS) {
                                errorMessage = this.strings.get("TS:OutdatedClient");
                            }
                            else if (message.text === RPL_BAD_HASH) {
                                errorMessage = this.strings.get("TXT_MISMATCH");
                            }
                            else if (message.text === RPL_MODE_UNAVAIL) {
                                errorMessage = this.strings.get("WOL:MatchModeUnavail");
                                isFatal = false;
                            }
                            else if (message.text === RPL_RATE_LIMITED) {
                                errorMessage = this.strings.get("WOL:MatchQueueJoinRateLimit");
                                isFatal = false;
                            }
                            else {
                                errorMessage = this.strings.get("WOL:MatchBadParameters");
                            }
                            if (!isFatal) {
                                this.leaveQueue();
                            }
                            this.handleError(message.text, errorMessage, { fatal: isFatal });
                        }
                    }
                    else {
                        console.warn(`Unexpected reply "${message.text}" from match bot (qs: ${QueueState[this.queueState]})`);
                    }
                }
                else if (message.text.startsWith(RPL_MATCHED + " ")) {
                    if (this.queueState === QueueState.WaitingForMatch) {
                        this.sound.play(SoundKey.PlayerJoined, ChannelType.Ui);
                        const countdownStr = message.text.split(" ")[1];
                        this.countdownSeconds = Number(countdownStr);
                        this.updateQueueState(QueueState.WaitingForStartTimer);
                    }
                    else {
                        console.warn(`Unexpected reply "${message.text}" from match bot (qs: ${QueueState[this.queueState]})`);
                    }
                }
                else if (message.text === RPL_REQUEUE) {
                    if ([QueueState.WaitingForGameStart, QueueState.WaitingForStartTimer].includes(this.queueState)) {
                        console.log("A player left. Returned to queue.");
                        this.updateQueueState(QueueState.WaitingForMatch);
                    }
                }
                else if (message.text === RPL_REMOVED_FROM_QUEUE) {
                    if (this.quickMatchChannelName) {
                        this.wolCon.leaveChannel(this.quickMatchChannelName);
                        this.quickMatchChannelName = undefined;
                    }
                    this.updateQueueState(QueueState.None);
                    if (this.partyState.partyId) {
                        this.partyState.status = PartyStatus.Idle;
                        this.partyState.members.forEach(member => (member.ready = false));
                        this.playButtonFlashing = false;
                        this.updatePartyUI();
                    }
                }
                else if (message.text.startsWith(RPL_STATS + " ") && this.queueState === QueueState.WaitingForMatch) {
                    if (this.isWaitingForTeammate()) {
                        this.updateSidebarText(this.strings.get("GUI:WaitingForTeammate"));
                    }
                    else {
                        const statsText = message.text.split(" ").slice(1).join(" ");
                        const [, avgWaitSecondsStr] = statsText.split(",");
                        const avgWaitSeconds = avgWaitSecondsStr !== "-1" ? Number(avgWaitSecondsStr) : undefined;
                        this.updateSidebarText(this.strings.get("TXT_SEARCHING_FOR", this.queueOpts.type) +
                            "\n\n" +
                            this.strings.get("WOL:MatchAvgWaitTime") +
                            "\n" +
                            (avgWaitSeconds !== undefined && avgWaitSeconds < 3600
                                ? this.strings.get("WOL:MatchAvgWaitTimeMinutes", avgWaitSeconds < 60 ? "<1" : "~" + Math.ceil(avgWaitSeconds / 60))
                                : this.strings.get("WOL:MatchAvgWaitTimeUnavail")));
                    }
                }
            }
        };
        this.handleLeaveChannel = async (event: WolChannelEvent) => {
            if (event.user.name === this.wolCon.getCurrentUser() && event.channel === this.quickMatchChannelName) {
                this.quickMatchChannelName = undefined;
                if (this.queueState !== QueueState.None) {
                    this.updateQueueState(QueueState.None);
                    this.wolCon.close();
                }
            }
        };
        this.handleGameStart = async (event: WolGameStartEvent) => {
            if (this.queueState === QueueState.WaitingForGameStart || this.queueState === QueueState.WaitingForStartTimer) {
                try {
                    const username = this.wolCon.getCurrentUser();
                    if (username === undefined) {
                        throw new Error("User should be logged in");
                    }
                    this.updateQueueState(QueueState.None);
                    const fallbackRoute = new MainMenuRoute(ScreenType.Login as any, {
                        forceRestoreSession: true,
                        afterLogin: (messages: any[]) => new MainMenuRoute(ScreenType.QuickGame as any, { messages }),
                    });
                    if (!this.form) {
                        await this.controller?.popScreen();
                    }
                    this.rootController.joinGame(event.gameId, event.timestamp, event.gservUrl, username, event.ticket, true, false, fallbackRoute);
                }
                catch (error) {
                    this.leaveQueue();
                    if (!this.wolCon.isOpen()) {
                        return;
                    }
                    this.handleError(error, this.strings.get("WOL:MatchTimeout"), { fatal: false });
                }
            }
        };
        this.onWolClose = () => {
            this.updateQueueState(QueueState.None);
        };
        this.onWolConLost = (error: any) => {
            this.handleError(error, this.strings.get("TXT_YOURE_DISCON"), { fatal: true });
        };
        this.handlePartyUpdate = (data: string) => {
            const parts = data.split(" ");
            const command = parts[0];
            if (command === PartyCode.RPL_PARTY_INVITE) {
                const inviterName = parts[1];
                if (inviterName) {
                    console.log("Party invite received from " + inviterName);
                    if (this.queueState !== QueueState.None) {
                        this.wolCon.partyDecline(inviterName);
                        console.warn(`Ignoring party invite from ${inviterName}: currently in queue`);
                    }
                    else if (this.partyState.partyId) {
                        console.warn(`Ignoring party invite from ${inviterName}: already in a party`);
                    }
                    else {
                        this.showInviteDialog(inviterName);
                    }
                }
                else {
                    console.warn("Party invite received but inviter name is missing");
                }
            }
            else if (command === PartyCode.RPL_PARTY_UPDATE) {
                const partyId = parts[1];
                const memberNames = parts[2]?.split(",") || [];
                const status = parts[3] === PartyStatus.Queued ? PartyStatus.Queued : PartyStatus.Idle;
                const firstReady = "1" === parts[4];
                const secondReady = "1" === parts[5];
                const members = memberNames.map((name, index) => ({
                    name: name,
                    ready: index === 0 ? firstReady : secondReady,
                }));
                const currentUser = this.wolCon.getCurrentUser();
                if (currentUser !== undefined) {
                    const myIndex = memberNames.indexOf(currentUser);
                    const myReady = members[myIndex]?.ready ?? false;
                    const flashing = (members[1 - myIndex]?.ready ?? false) && !myReady && status !== PartyStatus.Queued;
                    if (flashing && !this.playButtonFlashing) {
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:TeammateWantsToStart"));
                    }
                    this.playButtonFlashing = flashing;
                    this.partyState.partyId = partyId;
                    this.partyState.members = members;
                    this.partyState.status = status;
                    const wasPartySizeNotTwo = this.partySize !== 2;
                    this.partySize = memberNames.length;
                    if (this.partySize === 2 && this.queueOpts.type !== LadderQueueType.Team2v2) {
                        if (wasPartySizeNotTwo) {
                            this.savePrePartyQueueType();
                        }
                        this.queueOpts.type = LadderQueueType.Team2v2;
                    }
                    this.updatePartyUI();
                    if (this.queueState === QueueState.WaitingForMatch) {
                        this.updateSidebarText(this.isWaitingForTeammate()
                            ? this.strings.get("GUI:WaitingForTeammate")
                            : this.strings.get("TXT_SEARCHING_FOR", this.queueOpts.type));
                    }
                }
            }
            else if (command === PartyCode.RPL_PARTY_LEFT) {
                const leftUser = parts[1];
                this.leaveQueue();
                this.restorePrePartyQueueType();
                this.resetPartyState();
                this.updatePartyUI();
                const currentUser = this.wolCon.getCurrentUser();
                if (currentUser) {
                    if (leftUser === currentUser) {
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyLeft"));
                    }
                    else if (leftUser) {
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyMemberLeft", leftUser));
                        this.messageBoxApi.show(this.strings.get("GUI:PartyDisbanded"), this.strings.get("GUI:OK"));
                    }
                }
            }
            else if (command === PartyCode.RPL_PARTY_INVITE_DECLINED) {
                const playerName = parts[1];
                this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteDeclinedBy", playerName));
            }
            else if (command === PartyCode.RPL_PARTY_INVITE_EXPIRED) {
                this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteExpired"));
            }
            else if (command === PartyCode.RPL_PARTY_INVITE_SENT) {
                const playerName = parts[1];
                this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteSent", playerName));
            }
            else if (command === PartyCode.RPL_PARTY_FORMED) {
                const playerName = parts[1];
                this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyFormedWith", playerName));
                this.sound.play((SoundKey as any).PartyFormed, ChannelType.Ui);
            }
            else if (command === PartyCode.RPL_PARTY_INVITE_PREVENTION) {
                const playerName = parts[1];
                if (parts[2] === "1") {
                    this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInvitePreventionEnabled", playerName));
                }
            }
            else if (command === PartyCode.RPL_PARTY_INVITE_ERROR) {
                const errorCode = parts[1];
                const playerName = parts[2];
                switch (errorCode) {
                    case PartyCode.ERR_TARGET_IN_PARTY:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteAlreadyInParty", playerName));
                        break;
                    case PartyCode.ERR_TARGET_IN_QUEUE:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteInQueue", playerName));
                        break;
                    case PartyCode.ERR_INVITER_IN_PARTY:
                    case PartyCode.ERR_ACCEPTER_IN_PARTY:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteYouInParty"));
                        break;
                    case PartyCode.ERR_INVITE_PREVENTED:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInvitePrevented", playerName));
                        break;
                    case PartyCode.ERR_TARGET_NO_INVITES:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteNoInvites", playerName));
                        break;
                    case PartyCode.ERR_INVITE_ALREADY_PENDING:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteAlreadyPending", playerName));
                        break;
                    case PartyCode.ERR_NO_INVITE:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteNoInvite"));
                        break;
                    case PartyCode.ERR_TARGET_NOT_IN_QUICK_MATCH:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteNotInQuickMatch", playerName));
                        break;
                    case PartyCode.ERR_INVITER_NOT_IN_QUICK_MATCH:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteInviterNotInQuickMatch"));
                        break;
                    case PartyCode.ERR_TARGET_SELF:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteTargetSelf"));
                        break;
                    case PartyCode.ERR_INVITER_FRESH_ACCOUNT:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteInviterFreshAccount"));
                        break;
                    default:
                        this.chatUi?.addSystemMessage(this.strings.get("GUI:PartyInviteFailed", playerName));
                }
            }
        };
    }
    private invitePlayerPrompt: () => void;
    private handleChatMessage: (message: any) => void;
    private handleLeaveChannel: (event: WolChannelEvent) => Promise<void>;
    private handleGameStart: (event: WolGameStartEvent) => Promise<void>;
    private handlePartyUpdate: (data: string) => void;
    private onWolClose: () => void;
    private onWolConLost: (error: any) => void;
    collectRecentPlayers(): void {
        const currentUser = this.wolCon.getCurrentUser();
        const report = this.wolService.getLastGameReport();
        if (report) {
            for (const player of report.players) {
                if (player.name === currentUser) {
                    continue;
                }
                const existingIndex = this.recentQmPlayers.findIndex(entry => entry.name === player.name);
                if (existingIndex !== -1) {
                    this.recentQmPlayers.splice(existingIndex, 1);
                }
                this.recentQmPlayers.unshift({
                    name: player.name,
                    rankType: player.rankType,
                });
            }
            if (this.recentQmPlayers.length > 20) {
                this.recentQmPlayers.length = 20;
            }
        }
    }
    async onEnter(params: QuickGameScreenParams): Promise<void> {
        this.updateQueueState(QueueState.None);
        this.resetPartyState();
        this.collectRecentPlayers();
        const savedCountry = this.localPrefs.getItem(StorageKey.LastPlayerCountry);
        const savedColor = this.localPrefs.getItem(StorageKey.LastPlayerColor);
        const savedRanked = this.localPrefs.getItem(StorageKey.LastQueueRanked);
        const savedType = this.localPrefs.getItem(StorageKey.LastQueueType);
        const noInvitesPref = this.localPrefs.getItem(StorageKey.PartyNoInvites);
        this.noInvites = noInvitesPref === "1";
        const countryId = savedCountry !== undefined && Number(savedCountry) < this.getAvailablePlayerCountries().length
            ? Number(savedCountry)
            : RANDOM_COUNTRY_ID;
        const colorId = savedColor !== undefined && Number(savedColor) < this.getAvailablePlayerColors().length
            ? Number(savedColor)
            : RANDOM_COLOR_ID;
        const ranked = savedRanked === undefined || !this.unrankedEnabled || Boolean(Number(savedRanked));
        const queueType = savedType !== undefined && Object.values(LadderQueueType).includes(savedType as LadderQueueType)
            ? (savedType as LadderQueueType)
            : LadderQueueType.Solo1v1;
        this.queueOpts = {
            type: queueType,
            ranked: ranked,
            countryId: countryId,
            colorId: colorId,
        };
        this.playerProfile = undefined;
        this.controller.toggleMainVideo(false);
        if (this.wolService.isConnected() && this.wolCon.getCurrentUser()) {
            this.wolConfig = this.wolService.getConfig();
            this.wolCon.onClose.subscribe(this.onWolClose);
            this.disposables.add(() => this.wolCon.onClose.unsubscribe(this.onWolClose));
            this.wolService.onWolConnectionLost.subscribe(this.onWolConLost);
            this.disposables.add(() => this.wolService.onWolConnectionLost.unsubscribe(this.onWolConLost));
            this.wolCon.onChatMessage.subscribe(this.handleChatMessage);
            this.disposables.add(() => this.wolCon.onChatMessage.unsubscribe(this.handleChatMessage));
            this.wolCon.onLeaveChannel.subscribe(this.handleLeaveChannel);
            this.disposables.add(() => this.wolCon.onLeaveChannel.unsubscribe(this.handleLeaveChannel));
            this.wolCon.onGameStart.subscribe(this.handleGameStart);
            this.disposables.add(() => this.wolCon.onGameStart.unsubscribe(this.handleGameStart));
            this.wolCon.onPartyUpdate.subscribe(this.handlePartyUpdate);
            this.disposables.add(() => this.wolCon.onPartyUpdate.unsubscribe(this.handlePartyUpdate));
            this.disposables.add(() => this.resetPartyState());
            this.wolCon.partyStatus();
            this.wolCon.partyNoInvites(this.noInvites);
            const messages = params.messages ?? [];
            this.chatUi = new ChatUi(messages, () => {
                this.form?.applyOptions((options: any) => {
                    options.chatProps = this.chatUi.getChatProps();
                });
            }, this.wolConfig, this.wolCon, this.wolService, this.wladderService, this.strings, this.sound);
            this.disposables.add(this.chatUi, () => (this.chatUi = undefined));
            this.refreshSidebarButtons();
            this.initForm();
            this.updatePartyUI();
            this.requestPlayerProfileRefresh();
            this.wolCon.privmsg([this.wolConfig.getQuickMatchBotName()], REQ_LIST_QUEUES);
            this.updateStatsIntervalId = window.setInterval(() => {
                this.wolCon.privmsg([this.wolConfig.getQuickMatchBotName()], REQ_LIST_QUEUES);
            }, 30000);
            const channelJoinCancellation = new CancellationTokenSource();
            this.disposables.add(() => channelJoinCancellation.cancel());
            try {
                await this.chatUi.loadChannel(channelJoinCancellation.token);
            }
            catch (error) {
                let message = this.strings.get("WOL:MatchBadParameters");
                if (error instanceof WolError) {
                    const errorKey = new Map<number, string>()
                        .set(WolError.Code.NoSuchChannel, "WOL:ChannelJoinFailure")
                        .set(WolError.Code.BadChannelPass, "TXT_BADPASS")
                        .set(WolError.Code.ChannelFull, "TXT_CHANNEL_FULL")
                        .set(WolError.Code.BannedFromChannel, "TXT_JOINBAN")
                        .get(error.code);
                    if (errorKey) {
                        message = this.strings.get(errorKey);
                    }
                }
                messages.push({ text: message });
            }
        }
        else {
            this.controller.goToScreen(ScreenType.Login as any, {
                afterLogin: (messages: any[]) => new MainMenuRoute(ScreenType.QuickGame as any, { messages }),
            });
        }
    }
    private resetPartyState(): void {
        this.partyState = getInitialPartyState();
        this.partySize = 1;
        this.playButtonFlashing = false;
        this.prePartyQueueType = undefined;
    }
    private isWaitingForTeammate(): boolean {
        return !!this.partyState.partyId && this.partySize === 2 && !this.partyState.members.every(member => member.ready);
    }
    private savePrePartyQueueType(): void {
        if (this.queueOpts.type !== LadderQueueType.Team2v2) {
            this.prePartyQueueType = this.queueOpts.type;
        }
    }
    private restorePrePartyQueueType(): void {
        if (this.prePartyQueueType !== undefined) {
            this.queueOpts.type = this.prePartyQueueType;
            this.form?.applyOptions((options: any) => (options.type = this.prePartyQueueType));
            this.prePartyQueueType = undefined;
        }
    }
    private requestPlayerProfileRefresh(): void {
        this.refreshProfileTask?.cancel();
        this.refreshProfileTask = new Task((cancellationToken: CancellationToken) => this.refreshPlayerProfile(this.queueOpts.type, cancellationToken));
        this.refreshProfileTask.start().catch((error: any) => {
            if (!(error instanceof OperationCanceledError)) {
                console.error(error);
            }
        });
    }
    private async refreshPlayerProfile(queueType: LadderQueueType, cancellationToken: CancellationToken): Promise<void> {
        if (!this.wladderService.getUrl()) {
            return;
        }
        const username = this.wolCon.getCurrentUser();
        if (!username) {
            return;
        }
        const ladderType = getLadderTypeForQueueType(queueType);
        const [profile] = await this.wladderService.listSearch([username], cancellationToken, ladderType, WLadderService.CURRENT_SEASON, this.clientLocale);
        if (profile && !cancellationToken.isCancelled()) {
            this.playerProfile = profile;
            this.form?.applyOptions((options: any) => (options.playerProfile = this.playerProfile));
        }
    }
    private refreshSidebarButtons(): void {
        const buttons: any[] = [
            {
                label: this.strings.get("GUI:QuickMatchPlay"),
                tooltip: this.strings.get("GUI:FindAGame"),
                disabled: this.queueState !== QueueState.None,
                flashing: this.playButtonFlashing,
                onClick: () => {
                    if (this.availableQueueTypes.includes(this.queueOpts.type)) {
                        setTimeout(() => this.joinQueue(), 0);
                    }
                    else {
                        this.messageBoxApi.show(this.strings.get("WOL:MatchModeUnavail"), this.strings.get("GUI:OK"));
                    }
                },
            },
            ...(this.partyState.partyId ? [{
                label: this.strings.get("GUI:LeaveParty"),
                tooltip: this.strings.get("GUI:LeaveParty"),
                onClick: () => {
                    this.wolCon.partyLeave();
                },
            }] : []),
            ...(this.wladderService.getUrl() ? [{
                label: this.strings.get("GUI:ViewLadder"),
                tooltip: this.strings.get("GUI:ViewTourLadder"),
                onClick: () => {
                    const realm = this.sessionService.getSelectedRealm();
                    if (realm) {
                        this.controller?.pushScreen(ScreenType.Ladder as any, {
                            ladderType: getLadderTypeForQueueType(this.queueOpts.type),
                            realm: realm,
                            highlightPlayer: this.playerProfile,
                        });
                    }
                },
            }] : []),
            ...(this.hasScreen(ScreenType.LadderRules) ? [{
                label: this.strings.get("GUI:ViewRules"),
                onClick: () => {
                    this.controller?.pushScreen(ScreenType.LadderRules as any);
                },
            }] : []),
            {
                label: this.strings.get("GUI:Logout"),
                onClick: () => {
                    this.sessionService.clearRealmSession();
                    if (this.hasScreen(ScreenType.NicknameSelection)) {
                        this.controller?.goToScreen(ScreenType.NicknameSelection as any, {
                            afterLogin: (messages: any[]) => new MainMenuRoute(ScreenType.QuickGame as any, { messages }),
                        });
                    }
                    else {
                        this.controller?.goToScreen(ScreenType.Login as any, {
                            afterLogin: (messages: any[]) => new MainMenuRoute(ScreenType.QuickGame as any, { messages }),
                        });
                    }
                },
            },
            {
                label: this.queueState === QueueState.None ? this.strings.get("GUI:MainMenu") : this.strings.get("GUI:Cancel"),
                isBottom: true,
                onClick: () => {
                    if (this.queueState === QueueState.None) {
                        this.wolService.closeWolConnection();
                        this.controller?.goToScreen(ScreenType.Home as any);
                    }
                    else {
                        this.leaveQueue();
                    }
                },
            },
        ];
        this.controller.setSidebarButtons(buttons, true);
        this.controller.showSidebarButtons();
    }
    private hasScreen(screenType: number): boolean {
        return !!(this.controller as any)?.screens?.has?.(screenType);
    }
    private updateSidebarText(text: string): void {
        this.controller?.setSidebarMpContent({ text });
    }
    private initForm(): void {
        const [form] = this.jsxRenderer.render(jsx(HtmlView, {
            width: "100%",
            height: "100%",
            component: QuickGameForm,
            innerRef: (ref: any) => (this.form = ref),
            props: {
                strings: this.strings,
                disabled: this.queueState !== QueueState.None,
                countryUiNames: new Map([
                    [RANDOM_COUNTRY_NAME, RANDOM_COUNTRY_UI_NAME],
                    ...this.getAvailablePlayerCountryRules().map(country => [country.name, country.uiName] as [string, string]),
                ]),
                countryUiTooltips: new Map([
                    [RANDOM_COUNTRY_NAME, RANDOM_COUNTRY_UI_TOOLTIP],
                    ...this.getAvailablePlayerCountryRules().filter(country => country.uiTooltip).map(country => [country.name, country.uiTooltip] as [string, string]),
                ]),
                availableTypes: Object.values(LadderQueueType),
                enabledTypes: this.availableQueueTypes,
                availableColors: [RANDOM_COLOR_NAME, ...this.getAvailablePlayerColors()],
                availableCountries: [RANDOM_COUNTRY_NAME, ...this.getAvailablePlayerCountries()],
                color: this.getColorNameById(this.queueOpts.colorId),
                country: this.getCountryNameById(this.queueOpts.countryId),
                type: this.queueOpts.type,
                ranked: this.queueOpts.ranked,
                unrankedEnabled: this.unrankedEnabled,
                playerName: this.wolCon.getCurrentUser() ?? "",
                playerProfile: this.playerProfile,
                chatProps: {
                    ...this.chatUi.getChatProps(),
                    inviteToTeamDisabled: this.queueState !== QueueState.None,
                },
                partyState: this.partyState.partyId ? this.partyState : undefined,
                partySize: this.partySize,
                noInvites: this.noInvites,
                onInvitePlayer: this.invitePlayerPrompt,
                onNoInvitesChange: (value: boolean) => {
                    this.noInvites = value;
                    this.form?.applyOptions((options: any) => (options.noInvites = value));
                    this.localPrefs.setItem(StorageKey.PartyNoInvites, value ? "1" : "0");
                    this.wolCon.partyNoInvites(value);
                },
                onCountrySelect: (countryName: string) => {
                    const countryId = this.getCountryIdByName(countryName);
                    this.queueOpts.countryId = countryId;
                    this.form?.applyOptions((options: any) => (options.country = countryName));
                    if (countryId !== RANDOM_COUNTRY_ID) {
                        this.localPrefs.setItem(StorageKey.LastPlayerCountry, String(countryId));
                    }
                    else {
                        this.localPrefs.removeItem(StorageKey.LastPlayerCountry);
                    }
                },
                onColorSelect: (colorName: string) => {
                    const colorId = this.getColorIdByName(colorName);
                    this.queueOpts.colorId = colorId;
                    this.form?.applyOptions((options: any) => (options.color = colorName));
                    if (colorId !== RANDOM_COLOR_ID) {
                        this.localPrefs.setItem(StorageKey.LastPlayerColor, String(colorId));
                    }
                    else {
                        this.localPrefs.removeItem(StorageKey.LastPlayerColor);
                    }
                },
                onRankedChange: (ranked: boolean) => {
                    this.queueOpts.ranked = ranked;
                    this.form?.applyOptions((options: any) => (options.ranked = ranked));
                    this.localPrefs.setItem(StorageKey.LastQueueRanked, String(Number(ranked)));
                },
                onTypeChange: (type: string) => {
                    if (this.partySize <= (teamSizes.get(type as LadderQueueType) ?? Number.POSITIVE_INFINITY) && this.queueOpts.type !== type) {
                        this.queueOpts.type = type as LadderQueueType;
                        this.playerProfile = undefined;
                        this.form?.applyOptions((options: any) => {
                            options.type = type;
                            options.playerProfile = undefined;
                        });
                        this.localPrefs.setItem(StorageKey.LastQueueType, type);
                        if (this.form) {
                            this.requestPlayerProfileRefresh();
                        }
                    }
                },
            },
        }));
        this.controller.setMainComponent(form);
    }
    private getAvailablePlayerCountryRules(): CountryInfo[] {
        return this.rules.getMultiplayerCountries();
    }
    private getAvailablePlayerCountries(): string[] {
        return this.getAvailablePlayerCountryRules().map(country => country.name);
    }
    private getCountryNameById(countryId: number): string {
        return countryId === RANDOM_COUNTRY_ID ? RANDOM_COUNTRY_NAME : this.getAvailablePlayerCountries()[countryId];
    }
    private getCountryIdByName(countryName: string): number {
        if (countryName === RANDOM_COUNTRY_NAME) {
            return RANDOM_COUNTRY_ID;
        }
        return this.getAvailablePlayerCountries().indexOf(countryName);
    }
    private getAvailablePlayerColors(): string[] {
        return [...this.rules.getMultiplayerColors().values()].map(color => color.asHexString());
    }
    private getColorNameById(colorId: number): string {
        return colorId === RANDOM_COLOR_ID ? RANDOM_COLOR_NAME : this.getAvailablePlayerColors()[colorId];
    }
    private getColorIdByName(colorName: string): number {
        if (colorName === RANDOM_COLOR_NAME) {
            return RANDOM_COLOR_ID;
        }
        const colorId = this.getAvailablePlayerColors().indexOf(colorName);
        if (colorId === -1) {
            throw new Error(`Color ${colorName} not found in available player colors`);
        }
        return colorId;
    }
    private async joinQueue(): Promise<void> {
        const currentState = this.queueState;
        if (currentState !== QueueState.None) {
            return;
        }
        this.quickMatchChannelName = undefined;
        this.updateSidebarText(this.strings.get("WOL:RequestingMatch") + "...");
        this.updateQueueState(QueueState.Initializing);
        try {
            const channelName = `#Lob ${this.wolConfig.getQuickMatchChannelId(this.queueOpts.type)} 0`;
            await this.wolCon.joinChannel(channelName, this.wolConfig.getGlobalChannelPass());
            if (this.queueState !== QueueState.Initializing) {
                return;
            }
            this.quickMatchChannelName = channelName;
            const { countryId, colorId } = this.queueOpts;
            const request = REQ_MATCH + " " + [
                [TAG_COUNTRY, countryId],
                [TAG_COLOR, colorId],
                [TAG_VERSION, this.engineVersion],
                [TAG_MODHASH, this.engineModHash],
                [TAG_RANKED, Number(this.queueOpts.ranked)],
            ].map(pair => pair.join("=")).join(", ");
            this.wolCon.privmsg([this.wolConfig.getQuickMatchBotName()], request);
        }
        catch (error) {
            if (error instanceof WolError && error.code === WolError.Code.BadChannelPass) {
                this.handleError(error, this.strings.get("WOL:MatchModeUnavail"), { fatal: false });
            }
            else {
                this.handleError(error, this.strings.get("WOL:MatchBadParameters"), { fatal: true });
            }
        }
    }
    private leaveQueue(): void {
        if (this.queueState !== QueueState.None) {
            this.updateQueueState(QueueState.None);
            if (this.wolCon.isOpen() && this.quickMatchChannelName) {
                this.wolCon.leaveChannel(this.quickMatchChannelName);
                this.quickMatchChannelName = undefined;
            }
        }
    }
    private updateQueueState(newState: QueueState): void {
        this.queueState = newState;
        if (this.gameStartTimeoutId) {
            clearTimeout(this.gameStartTimeoutId);
            this.gameStartTimeoutId = undefined;
        }
        if (this.countdownIntervalId) {
            clearInterval(this.countdownIntervalId);
            this.countdownIntervalId = undefined;
        }
        if (this.updateStatsIntervalId) {
            clearInterval(this.updateStatsIntervalId);
            this.updateStatsIntervalId = undefined;
        }
        if (this.form) {
            this.form.applyOptions((options: any) => {
                options.disabled = newState !== QueueState.None;
                options.chatProps = {
                    ...options.chatProps,
                    inviteToTeamDisabled: newState !== QueueState.None,
                };
            });
            this.refreshSidebarButtons();
        }
        if (newState !== QueueState.None) {
            if (newState === QueueState.WaitingForGameStart) {
                this.gameStartTimeoutId = window.setTimeout(async () => {
                    console.log("Timed out. Rejoining queue...");
                    this.leaveQueue();
                    if (this.wolCon.isOpen()) {
                        this.joinQueue();
                    }
                }, 10000);
            }
            if (newState === QueueState.WaitingForStartTimer) {
                this.countdownIntervalId = window.setInterval(() => this.tickStartTimer(), 1000);
            }
            if (newState === QueueState.WaitingForMatch) {
                this.updateStatsIntervalId = window.setInterval(() => this.requestStats(), 5000);
            }
            let text: string | undefined;
            switch (newState) {
                case QueueState.WaitingForMatch:
                    text = this.isWaitingForTeammate()
                        ? this.strings.get("GUI:WaitingForTeammate")
                        : this.strings.get("TXT_SEARCHING_FOR", this.queueOpts.type);
                    break;
                case QueueState.WaitingForStartTimer:
                    text = this.strings.get("WOL:MatchStartSeconds", this.countdownSeconds);
                    break;
                case QueueState.WaitingForGameStart:
                    text = this.strings.get("WOL:MatchGameStarting");
                    break;
            }
            if (text !== undefined) {
                this.updateSidebarText(text);
                console.log(text);
            }
        }
        else {
            this.updateSidebarText("");
        }
    }
    private async tickStartTimer(): Promise<void> {
        if (this.countdownSeconds === undefined) {
            throw new Error("Game start countdown should be set by now");
        }
        if (this.countdownSeconds > 0) {
            this.countdownSeconds--;
            this.updateSidebarText(this.strings.get("WOL:MatchStartSeconds", this.countdownSeconds));
            this.sound.play(SoundKey.QuickMatchTimer, ChannelType.Ui);
        }
        else {
            this.updateQueueState(QueueState.WaitingForGameStart);
        }
    }
    private requestStats(): void {
        if (this.queueState === QueueState.WaitingForMatch) {
            this.wolCon.privmsg([this.wolConfig.getQuickMatchBotName()], REQ_STATS);
        }
    }
    async onUnstack(_params?: any): Promise<void> {
        this.refreshSidebarButtons();
        this.initForm();
        if (this.wolService.isConnected() && this.wolCon.getCurrentUser()) {
            this.wolCon.privmsg([this.wolConfig.getQuickMatchBotName()], REQ_LIST_QUEUES);
        }
        else {
            this.controller.goToScreen(ScreenType.Login as any, {
                afterLogin: (messages: any[]) => new MainMenuRoute(ScreenType.QuickGame as any, { messages }),
            });
        }
        this.requestPlayerProfileRefresh();
        this.updatePartyUI();
    }
    async onStack(): Promise<void> {
        await this.unrender();
    }
    async onLeave(): Promise<void> {
        this.updateQueueState(QueueState.None);
        if (this.refreshProfileTask) {
            this.refreshProfileTask.cancel();
            this.refreshProfileTask = undefined;
        }
        // Disposing the screen also disposes the ChatUi, which leaves its
        // channel and unsubscribes its handlers (upstream parity).
        this.disposables.dispose();
        if (this.wolCon.isOpen() && this.quickMatchChannelName) {
            this.wolCon.leaveChannel(this.quickMatchChannelName);
        }
        await this.unrender();
    }
    private async unrender(): Promise<void> {
        this.form = undefined;
        await this.controller.hideSidebarButtons();
    }
    private showInviteDialog(inviterName: string): void {
        if (this.pendingInvite) {
            clearTimeout(this.pendingInvite.timeoutId);
        }
        this.destroyInviteDialog();
        const hasDeclinedBefore = this.userHasDeclinedInvitesFrom.has(inviterName);
        const clearPendingInvite = () => {
            if (this.pendingInvite) {
                clearTimeout(this.pendingInvite.timeoutId);
                this.pendingInvite = undefined;
            }
        };
        const timeoutId = window.setTimeout(() => {
            this.pendingInvite = undefined;
            this.destroyInviteDialog();
        }, 30000);
        this.pendingInvite = {
            from: inviterName,
            timeoutId: timeoutId,
        };
        this.sound.play((SoundKey as any).PartyInvite, ChannelType.Ui);
        const [inviteDialog] = this.jsxRenderer.render(jsx(HtmlView, {
            component: PartyInviteDialog,
            props: {
                inviterName: inviterName,
                strings: this.strings,
                showPreventionCheckbox: hasDeclinedBefore,
                viewport: this.uiScene.viewport,
                onAccept: () => {
                    clearPendingInvite();
                    this.destroyInviteDialog();
                    this.leaveQueue();
                    this.userHasDeclinedInvitesFrom.delete(inviterName);
                    this.wolCon.partyAccept(inviterName);
                },
                onDecline: (preventInvites: boolean) => {
                    clearPendingInvite();
                    this.destroyInviteDialog();
                    this.wolCon.partyDecline(inviterName);
                    this.userHasDeclinedInvitesFrom.add(inviterName);
                    if (preventInvites) {
                        this.wolCon.partyPrevent(inviterName, true);
                    }
                },
            },
        }));
        this.inviteDialog = inviteDialog;
        this.uiScene.add(inviteDialog);
        this.disposables.add(inviteDialog, () => this.uiScene.remove(inviteDialog), () => (this.inviteDialog = undefined));
    }
    private destroyInviteDialog(): void {
        if (this.inviteDialog) {
            this.inviteDialog.destroy();
            this.inviteDialog = undefined;
        }
    }
    private updatePartyUI(): void {
        this.form?.applyOptions((options: any) => {
            options.partyState = this.partyState;
            options.partySize = this.partySize;
            options.type = this.queueOpts.type;
            options.onInvitePlayer = this.invitePlayerPrompt;
        });
        this.refreshSidebarButtons();
    }
    private handleError(error: any, message: string, { fatal }: {
        fatal: boolean;
    }): void {
        this.updateQueueState(QueueState.None);
        this.errorHandler.handle(error, message, () => {
            if (fatal) {
                this.wolService.closeWolConnection();
                this.controller?.goToScreen(ScreenType.Home as any);
            }
        });
    }
}
