import React from "react";
import { jsx } from "@/gui/jsx/jsx";
import { WolError } from "@/network/WolError";
import { LoginBox } from "@/gui/screen/mainMenu/login/LoginBox";
import { ScreenType } from "@/gui/screen/mainMenu/ScreenType";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { Task } from "@puzzl/core/lib/async/Task";
import { sleep } from "@puzzl/core/lib/async/sleep";
import { ServerRegions, Region } from "@/network/ServerRegions";
import { StorageKey, LocalPrefs } from "@/LocalPrefs";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { OperationCanceledError, CancellationToken } from "@puzzl/core/lib/async/cancellation";
import { MainMenuRoute } from "@/gui/screen/mainMenu/MainMenuRoute";
import { NicknameClaimPrompt } from "@/gui/screen/mainMenu/login/NicknameClaimPrompt";
import { DownloadError } from "@/network/HttpRequest";
import { WolService } from "@/network/WolService";
import { WLadderService } from "@/network/ladder/WLadderService";
import { WGameResService } from "@/network/WGameResService";
import { ErrorReportService } from "@/network/ErrorReportService";
import { MapTransferService } from "@/network/MapTransferService";
import { ErrorHandler } from "@/ErrorHandler";
import { Strings } from "@/data/Strings";
import { JsxRenderer } from "@/gui/jsx/JsxRenderer";
import { MessageBoxApi } from "@/gui/component/MessageBoxApi";
import { CfTurnstile } from "@/util/CfTurnstile";
import { AuthProvidersConfig, AuthProvider } from "@/conf/AuthProvidersConfig";
import { AuthPopupApi } from "@/gui/screen/mainMenu/login/AuthPopupApi";
import { AuthService } from "@/network/AuthService";
import { RealmService } from "@/network/RealmService";
import { SessionService } from "@/network/SessionService";
import { RealmSession } from "@/network/CreateRealmSessionResponse";
import { NicknameClaim } from "@/network/ClaimNicknameResponse";
import { MusicType } from "@/engine/sound/Music";

interface LoginScreenParams {
    afterLogin: (messages: { text: string }[]) => MainMenuRoute | {
        screenType: any;
        params: any;
    };
    forceRestoreSession?: boolean;
}

interface LoginBoxApi {
    submit(): void;
    resetTurnstile(): void;
}

interface NicknameClaimResponseWithError {
    nickname?: string;
    error?: string;
}

interface NicknameClaimPromptDismissal {
    realmId: string;
    nickname: string;
    skippedAt: number;
}

export class LoginScreen extends MainMenuScreen {
    static NICKNAME_CLAIM_PROMPT_DISMISSAL_MILLIS = 6048e5;

    private wolService: WolService;
    private wladderService: WLadderService;
    private wgameresService: WGameResService;
    private errorReportService: ErrorReportService;
    private mapTransferService: MapTransferService;
    private strings: Strings;
    private jsxRenderer: JsxRenderer;
    private messageBoxApi: MessageBoxApi;
    private serversUrl: string;
    private breakingNewsUrl: string;
    private errorHandler: ErrorHandler;
    private localPrefs: LocalPrefs;
    private rootController: any;
    private devMode: boolean;
    private cfTurnstile: CfTurnstile;
    private legacyRegistrationEnabled: boolean;
    private authProvidersConfig: AuthProvidersConfig;
    private authPopupApi: AuthPopupApi;
    private authService?: AuthService;
    private realmService?: RealmService;
    private sessionService: SessionService;
    private serverRegions = new ServerRegions();
    private params!: LoginScreenParams;
    private selectedRegion?: Region;
    private loginBoxApi?: LoginBoxApi | null;
    private loginBox?: any;
    private isBusy: boolean = false;
    private formRendered: boolean = false;
    private turnstileToken?: string;
    private serversUpdateTask?: Task<void>;

    constructor(wolService: WolService, wladderService: WLadderService, wgameresService: WGameResService, errorReportService: ErrorReportService, mapTransferService: MapTransferService, strings: Strings, jsxRenderer: JsxRenderer, messageBoxApi: MessageBoxApi, serversUrl: string, breakingNewsUrl: string, errorHandler: ErrorHandler, localPrefs: LocalPrefs, rootController: any, devMode: boolean, cfTurnstile: CfTurnstile, legacyRegistrationEnabled: boolean, authProvidersConfig: AuthProvidersConfig, authPopupApi: AuthPopupApi, authService: AuthService | undefined, realmService: RealmService | undefined, sessionService: SessionService) {
        super();
        this.wolService = wolService;
        this.wladderService = wladderService;
        this.wgameresService = wgameresService;
        this.errorReportService = errorReportService;
        this.mapTransferService = mapTransferService;
        this.strings = strings;
        this.jsxRenderer = jsxRenderer;
        this.messageBoxApi = messageBoxApi;
        this.serversUrl = serversUrl;
        this.breakingNewsUrl = breakingNewsUrl;
        this.errorHandler = errorHandler;
        this.localPrefs = localPrefs;
        this.rootController = rootController;
        this.devMode = devMode;
        this.cfTurnstile = cfTurnstile;
        this.legacyRegistrationEnabled = legacyRegistrationEnabled;
        this.authProvidersConfig = authProvidersConfig;
        this.authPopupApi = authPopupApi;
        this.authService = authService;
        this.realmService = realmService;
        this.sessionService = sessionService;
        this.title = this.strings.get("GUI:Login");
        this.musicType = MusicType.NormalShuffle;
        this.handleLoginSubmit = async (username: string, password: string, remember?: boolean, turnstileToken?: string) => {
            if (!this.isBusy && this.loginBoxApi && this.controller && (!this.cfTurnstile.isEnabledForLogin() || turnstileToken)) {
                const region = this.selectedRegion;
                if (region?.available) {
                    this.isBusy = true;
                    await this.controller.hideSidebarButtons();
                    if (username.match(/^[A-Za-z0-9-_]+$/)) {
                        const connectingTask = this.startLongConnectMsgTask();
                        let realmSession: RealmSession;
                        try {
                            const loginResult = await this.wolService.login(region, username, password, turnstileToken);
                            this.persistRememberedLogin(Boolean(remember), username, password);
                            realmSession = {
                                realmId: region.id,
                                nickname: loginResult.user,
                                sessionToken: loginResult.sessionToken,
                            };
                            this.sessionService.selectRealm(region);
                            this.sessionService.setRealmSession(realmSession);
                            if (loginResult.claimToken && this.authService && this.realmService && this.authProvidersConfig.getAll().length) {
                                this.sessionService.setNicknameClaim({
                                    realmId: region.id,
                                    nickname: loginResult.user,
                                    claimToken: loginResult.claimToken,
                                });
                            }
                            else {
                                this.sessionService.clearNicknameClaim();
                            }
                            connectingTask.cancel();
                            this.messageBoxApi.destroy();
                        }
                        catch (error) {
                            connectingTask.cancel();
                            this.messageBoxApi.destroy();
                            if (error instanceof WolError && error.code === WolError.Code.BadLogin) {
                                this.handleLoginError(error.reason ?? this.strings.get("TXT_BADPASS"));
                            }
                            else if (error instanceof WolError && error.code === WolError.Code.TurnstileVerificationFailed) {
                                this.handleLoginError(this.strings.get("TS:TurnstileFailed"));
                            }
                            else if (error instanceof WolError && error.code === WolError.Code.BannedFromServer) {
                                this.handleLoginError(error.reason ?? this.strings.get("TS:AccountBanned"));
                            }
                            else {
                                this.handleWolError(error, this.strings.get("TS:ConnectFailed"), {
                                    fatal: false,
                                    netError: true,
                                });
                            }
                            return;
                        }
                        if (this.wolService.validateGameVersion(region)) {
                            await this.offerNicknameClaim();
                            await this.connect(region, realmSession);
                        }
                        else {
                            this.handleLoginError(this.strings.get("TS:OutdatedClient"));
                        }
                    }
                    else {
                        this.handleBadPass();
                    }
                }
            }
        };
        this.handleAuthProviderLogin = (provider: AuthProvider) => {
            if (!this.authPopupApi.open(provider, this.handleAuthProviderComplete)) {
                window.location.assign(this.authPopupApi.getLoginUrl(provider, window.location.href));
            }
        };
        this.handleAuthProviderComplete = async () => {
            if (!this.authService) {
                throw new Error("Missing auth service");
            }
            try {
                const session = await this.authService.getSession();
                this.sessionService.setAccount(session.account!);
                this.goToRealmSelection();
            }
            catch (error) {
                const message = error instanceof DownloadError && error.statusCode === 401
                    ? this.strings.get("TS:SessionInvalidOrExpired")
                    : this.strings.get("TS:ConnectFailed");
                this.errorHandler.handle(error, message, () => {});
            }
        };
    }

    private handleLoginSubmit: (username: string, password: string, remember?: boolean, turnstileToken?: string) => Promise<void>;
    private handleAuthProviderLogin: (provider: AuthProvider) => void;
    private handleAuthProviderComplete: () => Promise<void>;

    async onEnter(params: LoginScreenParams): Promise<void> {
        if (params) {
            this.params = params;
        }
        this.formRendered = false;
        this.turnstileToken = undefined;
        this.controller.toggleMainVideo(false);
        const realmSession = this.sessionService.getRealmSession();
        if (this.authService && this.realmService) {
            if (realmSession) {
                if (this.sessionService.getAccount()) {
                    try {
                        const realms = await this.realmService.loadRealmList();
                        const realm = realms.find(realm => realm.id === realmSession!.realmId && realm.available);
                        const preferredRegion = this.localPrefs.getItem(StorageKey.PreferredServerRegion);
                        const preferredNickname = this.localPrefs.getItem(StorageKey.PreferredNickname);
                        const matchesPrefs = preferredRegion === realmSession.realmId && preferredNickname === realmSession.nickname;
                        if (realm && (matchesPrefs || params.forceRestoreSession)) {
                            this.isBusy = true;
                            this.connect(realm, realmSession);
                        }
                        else {
                            this.sessionService.clearRealmSession();
                            this.goToRealmSelection();
                        }
                        return;
                    }
                    catch (error) {
                        if (!(error instanceof DownloadError && error.statusCode === 401)) {
                            const message = error instanceof DownloadError && error.statusCode === 409
                                ? this.strings.get("TS:OutdatedClient")
                                : this.strings.get("TXT_NO_SERV_LIST");
                            this.errorHandler.handle(error, message, () => this.controller?.goToScreen(ScreenType.Home));
                            return;
                        }
                        this.sessionService.clearAccount();
                    }
                }
            }
            else {
                try {
                    if (!this.sessionService.getAccount()) {
                        const session = await this.authService.getSession();
                        this.sessionService.setAccount(session.account!);
                    }
                    this.goToRealmSelection();
                    return;
                }
                catch (error) {
                    if (!(error instanceof DownloadError && error.statusCode === 401)) {
                        this.handleWolError(error, this.strings.get("TS:ConnectFailed"), { fatal: true });
                        return;
                    }
                }
            }
        }
        try {
            await this.loadServerList();
        }
        catch (error) {
            this.handleWolError(error, this.strings.get("TXT_NO_SERV_LIST"), { fatal: true });
            return;
        }
        if (realmSession && this.serverRegions.isAvailable(realmSession.realmId)) {
            this.isBusy = true;
            const region = this.serverRegions.get(realmSession.realmId);
            if (this.wolService.validateGameVersion(region)) {
                this.connect(region, realmSession);
            }
            else {
                this.handleLoginError(this.strings.get("TS:OutdatedClient"));
            }
        }
        else {
            this.isBusy = false;
            this.initView();
        }
    }

    private async loadServerList(cancellationToken?: CancellationToken): Promise<void> {
        let isShowingConnecting = false;
        const timeout = setTimeout(async () => {
            this.messageBoxApi.show(this.strings.get("TXT_CONNECTING"));
            isShowingConnecting = true;
        }, 1000);
        try {
            const serverList = await this.wolService.loadServerList(this.serversUrl, cancellationToken);
            if (cancellationToken?.isCancelled()) {
                return;
            }
            this.serverRegions.load(serverList);
            if (this.selectedRegion) {
                this.selectedRegion = this.serverRegions
                    .getAll()
                    .find(region => region.id === this.selectedRegion!.id);
            }
        }
        finally {
            clearTimeout(timeout);
            if (isShowingConnecting) {
                this.messageBoxApi.destroy();
            }
        }
    }

    private initView(): void {
        if (!this.controller) {
            return;
        }
        this.updateSidebarButtons();
        if (!this.isBusy) {
            this.controller.showSidebarButtons();
        }
        if (!this.selectedRegion || !this.serverRegions.isAvailable(this.selectedRegion.id)) {
            const savedRegionId = this.localPrefs.getItem(StorageKey.PreferredServerRegion);
            this.selectedRegion = savedRegionId && this.serverRegions.isAvailable(savedRegionId)
                ? this.serverRegions.get(savedRegionId)
                : this.serverRegions.getFirstAvailable();
        }
        const rememberLogin = this.localPrefs.getBool(StorageKey.RememberLogin);
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            width: "100%",
            height: "100%",
            component: LoginBox,
            props: {
                ref: (ref: LoginBoxApi) => (this.loginBoxApi = ref),
                regions: this.serverRegions.getAll(),
                selectedRegion: this.selectedRegion,
                breakingNewsUrl: this.breakingNewsUrl,
                strings: this.strings,
                authProviders: this.authProvidersConfig.getAll(),
                onRegionChange: (regionId: string) => {
                    this.selectedRegion = this.serverRegions.get(regionId);
                    this.loginBox?.applyOptions((options: any) => {
                        options.selectedRegion = this.selectedRegion;
                    });
                    this.updateSidebarButtons();
                },
                onRequestRegionRefresh: () => {
                    this.updateServers();
                },
                onTurnstileTokenChange: (token?: string) => {
                    this.turnstileToken = token;
                    this.updateSidebarButtons();
                },
                rememberLogin,
                savedUsername: rememberLogin ? this.localPrefs.getItem(StorageKey.RememberedUsername) : undefined,
                savedPassword: rememberLogin ? this.getRememberedPassword() : undefined,
                onRememberLoginChange: (remember: boolean) => {
                    if (!remember) {
                        this.persistRememberedLogin(false);
                    }
                    else {
                        this.localPrefs.setItem(StorageKey.RememberLogin, "1");
                    }
                },
                onSubmit: this.handleLoginSubmit,
                onAuthProviderLogin: this.handleAuthProviderLogin,
                devMode: this.devMode,
                cfTurnstile: this.cfTurnstile,
            },
            innerRef: (ref: any) => (this.loginBox = ref),
        }));
        this.controller.setMainComponent(component);
        this.updateSidebarButtons();
        this.formRendered = true;
    }

    private updateSidebarButtons(): void {
        if (!this.controller) {
            return;
        }
        this.controller.setSidebarButtons([{
            label: this.strings.get("GUI:Login"),
            disabled: !this.selectedRegion?.available || (this.cfTurnstile.isEnabledForLogin() && !this.turnstileToken),
            onClick: () => {
                this.submitLoginForm();
            },
        }, {
            label: this.strings.get("GUI:NewAccount"),
            disabled: !this.legacyRegistrationEnabled && !this.authProvidersConfig.getAll().length,
            onClick: () => {
                this.controller?.goToScreen(ScreenType.NewAccount, {
                    regionId: this.selectedRegion?.id,
                    serverRegions: this.serverRegions,
                    afterLogin: this.params.afterLogin,
                });
            },
        }, {
            label: this.strings.get("GUI:Back"),
            isBottom: true,
            onClick: () => {
                this.controller?.goToScreen(ScreenType.Home);
            },
        }]);
    }

    private updateServers(): void {
        if (this.isBusy || this.serversUpdateTask) {
            return;
        }
        this.serversUpdateTask = new Task(async (cancellationToken) => {
            try {
                if (!this.formRendered) {
                    await sleep(500, cancellationToken);
                }
                await this.loadServerList(cancellationToken);
                if (cancellationToken.isCancelled()) {
                    return;
                }
                if (!this.selectedRegion || !this.serverRegions.isAvailable(this.selectedRegion.id)) {
                    this.selectedRegion = this.serverRegions.getFirstAvailable();
                }
                this.loginBox?.applyOptions((options: any) => {
                    options.selectedRegion = this.selectedRegion;
                    options.regions = this.serverRegions.getAll();
                });
                this.updateSidebarButtons();
                this.loginBox?.refresh();
            }
            catch (error) {
                if (!(error instanceof OperationCanceledError)) {
                    this.handleWolError(error, this.strings.get("TXT_NO_SERV_LIST"), {
                        fatal: true,
                    });
                }
            }
            finally {
                this.serversUpdateTask = undefined;
            }
        });
        this.serversUpdateTask.start().catch((error) => {
            if (!(error instanceof OperationCanceledError)) {
                console.error(error);
            }
        });
    }

    private submitLoginForm(): void {
        if (!this.isBusy && this.loginBoxApi && this.controller && this.selectedRegion?.available) {
            this.loginBoxApi.submit();
        }
    }

    private async offerNicknameClaim(): Promise<void> {
        const nicknameClaim = this.sessionService.getNicknameClaim();
        const authProviders = this.authProvidersConfig.getAll();
        if (nicknameClaim && this.authService && this.realmService && authProviders.length) {
            const dismissals = this.getNicknameClaimPromptDismissals();
            const nickname = nicknameClaim.nickname.toLowerCase();
            if (dismissals.some(dismissal => dismissal.realmId === nicknameClaim!.realmId && dismissal.nickname === nickname)) {
                this.sessionService.clearNicknameClaim();
            }
            else {
                await new Promise<void>((resolve) => {
                    let resolved = false;
                    const onDone = () => {
                        if (!resolved) {
                            resolved = true;
                            this.sessionService.clearNicknameClaim();
                            resolve();
                        }
                    };
                    this.messageBoxApi.show(React.createElement(NicknameClaimPrompt, {
                        nickname: nicknameClaim!.nickname,
                        strings: this.strings,
                        authProviders,
                        onDontShowAgainChange: (checked: boolean) => this.setNicknameClaimPromptDismissed(nicknameClaim!, checked),
                        onLogin: (provider: AuthProvider) => {
                            this.handleNicknameClaimProviderLogin(provider, onDone);
                        },
                    }), [{
                        label: this.strings.get("TS:SkipForNow"),
                        onClick: onDone,
                    }], {
                        className: "claim-nickname-box",
                    });
                });
            }
        }
    }

    private async handleNicknameClaimProviderLogin(provider: AuthProvider, onDone: () => void): Promise<void> {
        if (this.sessionService.getAccount()) {
            await this.claimNickname();
            onDone();
            return;
        }
        if (!this.authPopupApi.open(provider, () => this.handleNicknameClaimAuthComplete(onDone))) {
            window.location.assign(this.authPopupApi.getLoginUrl(provider, window.location.href));
        }
    }

    private async handleNicknameClaimAuthComplete(onDone: () => void): Promise<void> {
        try {
            const session = await this.authService!.getSession();
            this.sessionService.setAccount(session.account!);
            await this.claimNickname();
        }
        catch (error) {
            await this.handleNicknameClaimError(error);
        }
        onDone();
    }

    private async claimNickname(): Promise<void> {
        const nicknameClaim = this.sessionService.getNicknameClaim();
        const realmService = this.realmService;
        if (nicknameClaim && realmService) {
            try {
                const result = await realmService.claimNickname(nicknameClaim.realmId, nicknameClaim.claimToken) as NicknameClaimResponseWithError;
                if (result.error !== undefined) {
                    await this.messageBoxApi.alert(result.error, this.strings.get("GUI:OK"));
                }
                else {
                    await this.messageBoxApi.alert(this.strings.get("TS:NicknameClaimed", result.nickname), this.strings.get("GUI:OK"));
                }
            }
            catch (error) {
                if (error instanceof DownloadError && error.statusCode === 401) {
                    this.sessionService.clearAccount();
                }
                await this.handleNicknameClaimError(error);
            }
        }
    }

    private async handleNicknameClaimError(error: any): Promise<void> {
        const message = error instanceof DownloadError && error.statusCode === 401
            ? this.strings.get("TS:SessionInvalidOrExpired")
            : this.strings.get("TS:ConnectFailed");
        await new Promise<void>((resolve) => this.errorHandler.handle(error, message, () => resolve()));
    }

    private getNicknameClaimPromptDismissals(now: number = Date.now()): NicknameClaimPromptDismissal[] {
        const stored = this.localPrefs.getItem(StorageKey.NicknameClaimPromptDismissals);
        if (!stored) {
            return [];
        }
        let parsed: any;
        try {
            parsed = JSON.parse(stored);
        }
        catch {
            this.localPrefs.removeItem(StorageKey.NicknameClaimPromptDismissals);
            return [];
        }
        if (!Array.isArray(parsed)) {
            this.localPrefs.removeItem(StorageKey.NicknameClaimPromptDismissals);
            return [];
        }
        const valid = parsed.filter((entry: any) =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.realmId === "string" &&
            entry.realmId.length > 0 &&
            typeof entry.nickname === "string" &&
            entry.nickname.length > 0 &&
            typeof entry.skippedAt === "number" &&
            Number.isFinite(entry.skippedAt));
        const cutoff = now - LoginScreen.NICKNAME_CLAIM_PROMPT_DISMISSAL_MILLIS;
        const filtered = valid.filter((entry: NicknameClaimPromptDismissal) => entry.skippedAt >= cutoff && entry.skippedAt <= now);
        if (filtered.length !== valid.length || valid.length !== parsed.length) {
            this.localPrefs.setItem(StorageKey.NicknameClaimPromptDismissals, JSON.stringify(filtered));
        }
        return filtered;
    }

    private setNicknameClaimPromptDismissed(nicknameClaim: NicknameClaim, dismissed: boolean): void {
        const nickname = nicknameClaim.nickname.toLowerCase();
        const dismissals = this.getNicknameClaimPromptDismissals().filter(dismissal => dismissal.realmId !== nicknameClaim.realmId || dismissal.nickname !== nickname);
        if (dismissed) {
            dismissals.push({
                realmId: nicknameClaim.realmId,
                nickname,
                skippedAt: Date.now(),
            });
        }
        this.localPrefs.setItem(StorageKey.NicknameClaimPromptDismissals, JSON.stringify(dismissals));
    }

    private goToRealmSelection(): void {
        this.controller?.goToScreen(ScreenType.RealmSelection, {
            afterLogin: this.params.afterLogin,
        });
    }

    private async connect(region: Region, realmSession: RealmSession): Promise<void> {
        this.serversUpdateTask?.cancel();
        this.serversUpdateTask = undefined;
        const connectingTask = this.startLongConnectMsgTask();
        this.sessionService.selectRealm(region);
        let wasCancelled = false;
        try {
            let messages: { text: string }[] = [];
            if (!this.wolService.isConnected() || !this.wolService.getConnection().getCurrentUser()) {
                messages = await this.wolService.connect({
                    url: region.wolUrl,
                    sessionToken: realmSession.sessionToken,
                }, ({ position, avgWaitSeconds }: { position: number; avgWaitSeconds: number }) => {
                    connectingTask.cancel();
                    this.messageBoxApi.show(this.strings.get("TS:ServerFull") +
                        "\n\n\n" +
                        this.strings.get("TS:LoginPositionInQueue", position) +
                        "\n" +
                        this.strings.get("TS:LoginAvgWaitTime") +
                        (avgWaitSeconds > 0 && avgWaitSeconds < 3600
                            ? this.strings.get("TS:LoginAvgWaitTimeMinutes", avgWaitSeconds < 60 ? "<1" : "~" + Math.ceil(avgWaitSeconds / 60))
                            : this.strings.get("TS:LoginAvgWaitTimeUnavail")), this.strings.get("GUI:Cancel"), () => {
                        wasCancelled = true;
                        this.sessionService.clearRealmSession();
                    });
                });
                this.wladderService.setUrl(region.wladderUrl!);
                this.wgameresService.setUrl(region.wgameresUrl!);
                if (region.errorReportUrl) {
                    this.errorReportService.setUrl(region.errorReportUrl);
                }
                this.mapTransferService.setUrl(region.mapTransferUrl!);
            }
            connectingTask.cancel();
            this.messageBoxApi.destroy();
            this.localPrefs.setItem(StorageKey.PreferredServerRegion, region.id);
            const result = this.params.afterLogin(messages);
            if (result instanceof MainMenuRoute) {
                this.controller?.goToScreen(result.screenType, result.params);
            }
            else {
                this.rootController.goToScreen(result.screenType, result.params);
            }
        }
        catch (error) {
            connectingTask.cancel();
            this.messageBoxApi.destroy();
            if (wasCancelled) {
                this.isBusy = false;
                if (this.formRendered) {
                    this.updateSidebarButtons();
                    this.controller?.showSidebarButtons();
                }
                else {
                    this.initView();
                }
                return;
            }
            if (error instanceof WolError && error.code === WolError.Code.OutdatedClient) {
                this.handleWolError(error, this.strings.get("TS:OutdatedClient"), {
                    fatal: false,
                });
                return;
            }
            if (error instanceof WolError && error.code === WolError.Code.BadSession) {
                this.sessionService.clearRealmSession();
                if (this.authService && this.realmService) {
                    this.messageBoxApi.show(this.strings.get("TS:SessionInvalidOrExpired"), this.strings.get("GUI:Ok"), () => this.goToRealmSelection());
                }
                else {
                    this.handleLoginError(this.strings.get("TS:SessionInvalidOrExpired"));
                }
            }
            else if (error instanceof WolError && error.code === WolError.Code.ServerFull) {
                this.handleLoginError(this.strings.get("TS:ServerFull"));
            }
            else {
                this.handleWolError(error, this.strings.get("TS:ConnectFailed"), {
                    fatal: false,
                    netError: true,
                });
            }
        }
    }

    private startLongConnectMsgTask(): Task<void> {
        const task = new Task<void>(async (cancellationToken) => {
            await sleep(1000, cancellationToken);
            if (!cancellationToken.isCancelled()) {
                this.messageBoxApi.show(this.strings.get("TXT_CONNECTING"));
            }
        });
        task.start().catch((error) => {
            if (!(error instanceof OperationCanceledError)) {
                console.error(error);
            }
        });
        return task;
    }

    private persistRememberedLogin(remember: boolean, username?: string, password?: string): void {
        if (remember && username && password) {
            this.localPrefs.setItem(StorageKey.RememberLogin, "1");
            this.localPrefs.setItem(StorageKey.RememberedUsername, username);
            this.localPrefs.setItem(StorageKey.RememberedPassword, LoginScreen.obfuscatePassword(password));
        }
        else {
            this.localPrefs.setItem(StorageKey.RememberLogin, "0");
            this.localPrefs.removeItem(StorageKey.RememberedUsername);
            this.localPrefs.removeItem(StorageKey.RememberedPassword);
        }
    }

    private getRememberedPassword(): string | undefined {
        const stored = this.localPrefs.getItem(StorageKey.RememberedPassword);
        return stored ? LoginScreen.deobfuscatePassword(stored) : undefined;
    }

    // Not encryption: only meant to avoid keeping the password in cleartext at rest in localStorage.
    private static obfuscatePassword(password: string): string {
        try {
            return btoa(encodeURIComponent(password));
        }
        catch {
            return "";
        }
    }

    private static deobfuscatePassword(value: string): string | undefined {
        try {
            return decodeURIComponent(atob(value));
        }
        catch {
            return undefined;
        }
    }

    private handleBadPass(): void {
        this.handleLoginError(this.strings.get("TXT_BADPASS"));
    }

    private handleLoginError(message: string): void {
        this.messageBoxApi.show(message, this.strings.get("GUI:Ok"), () => {
            this.isBusy = false;
            this.turnstileToken = undefined;
            this.loginBoxApi?.resetTurnstile();
            if (this.formRendered) {
                this.updateSidebarButtons();
                this.controller.showSidebarButtons();
            }
            else {
                this.initView();
            }
        });
    }

    private handleWolError(error: any, message: string, { fatal, netError }: {
        fatal: boolean;
        netError?: boolean;
    } = { fatal: false }): void {
        this.errorHandler.handle(error, message, () => {
            this.isBusy = false;
            this.serversUpdateTask?.cancel();
            this.serversUpdateTask = undefined;
            this.wolService.closeWolConnection();
            if (fatal) {
                this.controller?.goToScreen(ScreenType.Home);
            }
            else {
                this.turnstileToken = undefined;
                this.loginBoxApi?.resetTurnstile();
                if (this.formRendered) {
                    this.updateSidebarButtons();
                    this.controller?.showSidebarButtons();
                }
                else {
                    this.initView();
                    if (netError) {
                        this.updateServers();
                    }
                }
            }
        });
    }

    async onLeave(): Promise<void> {
        this.loginBoxApi = null;
        this.loginBox = undefined;
        this.formRendered = false;
        this.serversUpdateTask?.cancel();
        this.serversUpdateTask = undefined;
        this.authPopupApi.dispose();
        if (!this.isBusy) {
            await this.controller.hideSidebarButtons();
        }
        this.isBusy = false;
    }
}
