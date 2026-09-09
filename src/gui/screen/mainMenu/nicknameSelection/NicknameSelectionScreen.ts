import React from "react";
import { Task } from "@puzzl/core/lib/async/Task";
import { OperationCanceledError, CancellationToken } from "@puzzl/core/lib/async/cancellation";
import { jsx } from "@/gui/jsx/jsx";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { DownloadError } from "@/network/HttpRequest";
import { WolError } from "@/network/WolError";
import { MIN_USERNAME_LEN, MAX_USERNAME_LEN } from "@/network/WolConfig";
import { StorageKey, LocalPrefs } from "@/LocalPrefs";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { MainMenuRoute } from "@/gui/screen/mainMenu/MainMenuRoute";
import { ScreenType } from "@/gui/screen/mainMenu/ScreenType";
import { NicknameClaimCredentialsPrompt, NicknameClaimCredentialsPromptApi, NicknameClaimCredentials } from "@/gui/screen/mainMenu/nicknameSelection/NicknameClaimCredentialsPrompt";
import { NicknameSelectionBox } from "@/gui/screen/mainMenu/nicknameSelection/NicknameSelectionBox";
import type { RealmService } from "@/network/RealmService";
import type { SessionService } from "@/network/SessionService";
import type { WolService } from "@/network/WolService";
import type { CfTurnstile } from "@/util/CfTurnstile";
import type { CreateRealmSessionResponse } from "@/network/CreateRealmSessionResponse";
import type { RealmSession } from "@/network/CreateRealmSessionResponse";
import type { ClaimNicknameResponse } from "@/network/ClaimNicknameResponse";
import type { CreateNicknameResponse } from "@/network/CreateNicknameResponse";
import type { ErrorHandler } from "@/ErrorHandler";
import type { MessageBoxApi } from "@/gui/component/MessageBoxApi";

interface WladderService {
    setUrl(url?: string): void;
}

interface WgameresService {
    setUrl(url?: string): void;
}

interface ErrorReportServiceLike {
    setUrl(url?: string): void;
}

interface MapTransferService {
    setUrl(url?: string): void;
}

interface RootController {
    goToScreen(screenType: any, params: any): void;
}

interface NicknameSelectionBoxApi {
    applyOptions(update: (options: any) => void): void;
    refresh(): void;
}

interface NicknameSelectionScreenParams {
    autoLoginNickname?: string;
    afterLogin: (messages: any[]) => MainMenuRoute | { screenType: any; params: any };
    [key: string]: any;
}

export class NicknameSelectionScreen extends MainMenuScreen {
    private strings: any;
    private jsxRenderer: any;
    private messageBoxApi: MessageBoxApi;
    private errorHandler: ErrorHandler;
    private rootController: RootController;
    private wladderService: WladderService;
    private wgameresService: WgameresService;
    private errorReportService: ErrorReportServiceLike;
    private mapTransferService: MapTransferService;
    private wolService: WolService;
    private realmService: RealmService;
    private sessionService: SessionService;
    private localPrefs: LocalPrefs;
    private cfTurnstile: CfTurnstile;
    private nicknames: string[] = [];
    private maxNicknames: number = 0;
    private selectedNickname?: string;
    private nicknameBox?: NicknameSelectionBoxApi;
    private nicknameListTask?: Task<void>;
    private nicknameCreateTask?: Task<CreateNicknameResponse>;
    private isBusy: boolean = false;
    private autoLogin: boolean = false;
    private params!: NicknameSelectionScreenParams;
    private handleNicknameChange: (nickname: string) => void;
    private handleNicknameDoubleClick: (nickname: string) => void;
    private handleAutoLoginChange: (autoLogin: boolean) => void;
    private handleClaimNickname: () => Promise<void>;
    private handleCreateNickname: (defaultValue?: string) => Promise<void>;

    constructor(strings: any, jsxRenderer: any, messageBoxApi: MessageBoxApi, errorHandler: ErrorHandler, rootController: RootController, wladderService: WladderService, wgameresService: WgameresService, errorReportService: ErrorReportServiceLike, mapTransferService: MapTransferService, wolService: WolService, realmService: RealmService, sessionService: SessionService, localPrefs: LocalPrefs, cfTurnstile: CfTurnstile) {
        super();
        this.strings = strings;
        this.jsxRenderer = jsxRenderer;
        this.messageBoxApi = messageBoxApi;
        this.errorHandler = errorHandler;
        this.rootController = rootController;
        this.wladderService = wladderService;
        this.wgameresService = wgameresService;
        this.errorReportService = errorReportService;
        this.mapTransferService = mapTransferService;
        this.wolService = wolService;
        this.realmService = realmService;
        this.sessionService = sessionService;
        this.localPrefs = localPrefs;
        this.cfTurnstile = cfTurnstile;
        this.title = this.strings.get("GUI:Nickname");
        this.nicknames = [];
        this.maxNicknames = 0;
        this.isBusy = false;
        this.autoLogin = false;
        this.handleNicknameChange = (nickname: string) => {
            this.selectedNickname = nickname;
            this.nicknameBox?.applyOptions((options: any) => (options.selectedNickname = nickname));
            this.nicknameBox?.refresh();
            this.updateSidebarButtons();
        };
        this.handleNicknameDoubleClick = (nickname: string) => {
            this.handleNicknameChange(nickname);
            this.handleSubmit();
        };
        this.handleAutoLoginChange = (autoLogin: boolean) => {
            this.autoLogin = autoLogin;
            this.localPrefs.setItem(StorageKey.AutoLogin, String(Number(autoLogin)));
            this.nicknameBox?.applyOptions((options: any) => (options.autoLogin = autoLogin));
            this.nicknameBox?.refresh();
        };
        this.handleClaimNickname = async () => {
            if (!this.isBusy) {
                const realm = this.sessionService.getSelectedRealm();
                if (realm) {
                    this.isBusy = true;
                    this.updateSidebarButtons();
                    let claimSucceeded = false;
                    try {
                        const credentials = await new Promise<NicknameClaimCredentials | undefined>(resolve => {
                            const ref = React.createRef<NicknameClaimCredentialsPromptApi>();
                            this.messageBoxApi.show(React.createElement(NicknameClaimCredentialsPrompt, {
                                ref,
                                strings: this.strings,
                                cfTurnstile: this.cfTurnstile,
                                onSubmit: resolve,
                            }), [{
                                label: this.strings.get("GUI:OK"),
                                onClick: () => ref.current?.submit() ?? false,
                            }, {
                                label: this.strings.get("GUI:Cancel"),
                                onClick: () => resolve(undefined),
                            }], {
                                className: "credentials-prompt",
                            });
                        });
                        if (!credentials) {
                            return;
                        }
                        this.messageBoxApi.show(this.strings.get("TXT_CONNECTING"));
                        const loginResult = await this.wolService.login(realm, credentials.user, credentials.pass, credentials.turnstileToken);
                        if (!loginResult.claimToken) {
                            await this.messageBoxApi.alert(this.strings.get("TS:NicknameClaimUnavailable"), this.strings.get("GUI:OK"));
                            return;
                        }
                        const claimResult = await this.realmService.claimNickname(realm.id, loginResult.claimToken) as ClaimNicknameResponse & { error?: string };
                        if (claimResult.error !== undefined) {
                            await this.messageBoxApi.alert(claimResult.error, this.strings.get("GUI:OK"));
                            return;
                        }
                        claimSucceeded = true;
                        await this.runNicknameListTask(claimResult.nickname);
                        await this.messageBoxApi.alert(this.strings.get("TS:NicknameClaimed", claimResult.nickname), this.strings.get("GUI:OK"));
                    }
                    catch (error) {
                        if (error instanceof OperationCanceledError) {
                            return;
                        }
                        if (error instanceof DownloadError && error.statusCode === 401) {
                            this.messageBoxApi.destroy();
                            this.sessionService.clearAccount();
                            this.controller?.goToScreen(ScreenType.Login, this.params);
                            return;
                        }
                        if (error instanceof DownloadError && error.statusCode === 404) {
                            this.messageBoxApi.destroy();
                            this.controller?.goToScreen(ScreenType.RealmSelection, this.params);
                            return;
                        }
                        if (claimSucceeded) {
                            this.errorHandler.handle(error, this.strings.get("TS:ConnectFailed"), () => this.controller?.goToScreen(ScreenType.RealmSelection, this.params));
                            return;
                        }
                        if (error instanceof WolError && (error.code === WolError.Code.BadLogin || error.code === WolError.Code.BannedFromServer || error.code === WolError.Code.TurnstileVerificationFailed)) {
                            const message = error.code === WolError.Code.TurnstileVerificationFailed
                                ? this.strings.get("TS:TurnstileFailed")
                                : error.reason ?? (error.code === WolError.Code.BannedFromServer ? this.strings.get("TS:AccountBanned") : this.strings.get("TXT_BADPASS"));
                            await this.messageBoxApi.alert(message, this.strings.get("GUI:OK"));
                            return;
                        }
                        this.errorHandler.handle(error, this.strings.get("TS:ConnectFailed"), () => { });
                    }
                    finally {
                        this.isBusy = false;
                        this.updateSidebarButtons();
                        this.controller?.showSidebarButtons();
                    }
                }
                else {
                    this.controller?.goToScreen(ScreenType.RealmSelection, this.params);
                }
            }
        };
        this.handleCreateNickname = async (defaultValue?: string) => {
            if (!this.isBusy) {
                const nickname = await this.messageBoxApi.prompt(this.strings.get("GUI:Nickname"), this.strings.get("GUI:OK"), this.strings.get("GUI:Cancel"), {
                    required: true,
                    minLength: MIN_USERNAME_LEN,
                    maxLength: MAX_USERNAME_LEN,
                    pattern: "[a-zA-Z0-9_\\-]+",
                    defaultValue,
                });
                if (nickname !== undefined) {
                    const realm = this.sessionService.getSelectedRealm();
                    if (realm) {
                        this.isBusy = true;
                        this.updateSidebarButtons();
                        const task = this.nicknameCreateTask = new Task<CreateNicknameResponse>(ct => this.realmService.createNickname(realm.id, nickname, ct));
                        let createSucceeded = false;
                        try {
                            const createResult = await task.start();
                            if (createResult.error !== undefined) {
                                this.messageBoxApi.show(createResult.error, this.strings.get("GUI:Ok"), () => {
                                    this.isBusy = false;
                                    this.updateSidebarButtons();
                                    this.handleCreateNickname(nickname);
                                });
                                return;
                            }
                            if (!createResult.nickname) {
                                throw new Error("Missing nickname in successful nickname creation response");
                            }
                            createSucceeded = true;
                            await this.runNicknameListTask(createResult.nickname);
                            this.isBusy = false;
                            this.updateSidebarButtons();
                        }
                        catch (error) {
                            if (error instanceof OperationCanceledError) {
                                return;
                            }
                            if (error instanceof DownloadError && error.statusCode === 401) {
                                this.sessionService.clearAccount();
                                this.controller?.goToScreen(ScreenType.Login, this.params);
                                return;
                            }
                            if (error instanceof DownloadError && error.statusCode === 404) {
                                this.controller?.goToScreen(ScreenType.RealmSelection, this.params);
                                return;
                            }
                            if (createSucceeded) {
                                this.errorHandler.handle(error, this.strings.get("TS:ConnectFailed"), () => this.controller?.goToScreen(ScreenType.RealmSelection, this.params));
                                return;
                            }
                            this.errorHandler.handle(error, this.strings.get("TS:ConnectFailed"), () => {
                                this.isBusy = false;
                                this.updateSidebarButtons();
                            });
                        }
                        finally {
                            if (this.nicknameCreateTask === task) {
                                this.nicknameCreateTask = undefined;
                            }
                        }
                    }
                    else {
                        this.controller?.goToScreen(ScreenType.RealmSelection, this.params);
                    }
                }
            }
        };
    }

    async onEnter(params: NicknameSelectionScreenParams): Promise<void> {
        this.params = params;
        this.controller.toggleMainVideo(false);
        this.isBusy = false;
        this.autoLogin = Boolean(Number(this.localPrefs.getItem(StorageKey.AutoLogin) ?? true));
        if (this.sessionService.getAccount()) {
            if (this.sessionService.getSelectedRealm()) {
                try {
                    await this.runNicknameListTask(params.autoLoginNickname);
                }
                catch (error) {
                    if (error instanceof OperationCanceledError) {
                        return;
                    }
                    if (error instanceof DownloadError && error.statusCode === 401) {
                        this.sessionService.clearAccount();
                        this.controller.goToScreen(ScreenType.Login, params);
                        return;
                    }
                    if (error instanceof DownloadError && error.statusCode === 404) {
                        this.controller.goToScreen(ScreenType.RealmSelection, params);
                        return;
                    }
                    this.errorHandler.handle(error, this.strings.get("TS:ConnectFailed"), () => this.controller?.goToScreen(ScreenType.RealmSelection, params));
                    return;
                }
                const autoLoginSucceeded = params.autoLoginNickname !== undefined && params.autoLoginNickname === this.selectedNickname;
                if (params.autoLoginNickname && !autoLoginSucceeded) {
                    this.localPrefs.removeItem(StorageKey.PreferredNickname);
                }
                const [component] = this.jsxRenderer.render(jsx(HtmlView, {
                    width: "100%",
                    height: "100%",
                    component: NicknameSelectionBox,
                    props: {
                        strings: this.strings,
                        nicknames: this.nicknames,
                        maxNicknames: this.maxNicknames,
                        selectedNickname: this.selectedNickname,
                        autoLogin: this.autoLogin,
                        onChange: this.handleNicknameChange,
                        onDoubleClick: this.handleNicknameDoubleClick,
                        onAutoLoginChange: this.handleAutoLoginChange,
                    },
                    innerRef: (ref: NicknameSelectionBoxApi) => (this.nicknameBox = ref),
                }));
                this.controller.setMainComponent(component);
                if (autoLoginSucceeded) {
                    await this.handleSubmit();
                }
                else {
                    this.updateSidebarButtons();
                    this.controller.showSidebarButtons();
                }
            }
            else {
                this.controller.goToScreen(ScreenType.RealmSelection, params);
            }
        }
        else {
            this.controller.goToScreen(ScreenType.Login, params);
        }
    }

    private updateSidebarButtons(): void {
        this.controller.setSidebarButtons([
            {
                label: this.strings.get("GUI:Login"),
                disabled: this.isBusy || !this.selectedNickname,
                onClick: () => this.handleSubmit(),
            },
            {
                label: this.strings.get("GUI:WolNewNickname"),
                disabled: this.isBusy,
                onClick: () => this.handleCreateNickname(),
            },
            {
                label: this.strings.get("GUI:LinkNickname"),
                disabled: this.isBusy,
                onClick: () => this.handleClaimNickname(),
            },
            {
                label: this.strings.get("GUI:Back"),
                isBottom: true,
                onClick: () => this.controller?.goToScreen(ScreenType.RealmSelection, this.params),
            },
        ]);
    }

    private async handleSubmit(): Promise<void> {
        const nickname = this.selectedNickname;
        if (!this.isBusy && nickname) {
            const realm = this.sessionService.getSelectedRealm();
            if (realm) {
                if (this.autoLogin) {
                    this.localPrefs.setItem(StorageKey.PreferredNickname, nickname);
                }
                else {
                    this.localPrefs.removeItem(StorageKey.PreferredNickname);
                }
                this.isBusy = true;
                if (!this.params.autoLoginNickname || !this.autoLogin) {
                    await this.controller?.hideSidebarButtons();
                }
                this.messageBoxApi.show(this.strings.get("TXT_CONNECTING"));
                let queueCancelled = false;
                try {
                    const createSessionResult = await this.realmService.createSession(realm.id, nickname) as CreateRealmSessionResponse & { error?: string };
                    if (createSessionResult.error !== undefined) {
                        this.sessionService.clearRealmSession();
                        this.messageBoxApi.show(createSessionResult.error, this.strings.get("GUI:Ok"), () => {
                            this.isBusy = false;
                            this.updateSidebarButtons();
                            this.controller?.showSidebarButtons();
                        });
                        return;
                    }
                    const realmSession = {
                        realmId: realm.id,
                        ...createSessionResult,
                    };
                    this.sessionService.setRealmSession(realmSession as RealmSession);
                    const messages = this.wolService.isConnected() && this.wolService.getConnection().getCurrentUser()
                        ? []
                        : await this.wolService.connect({
                            url: realm.wolUrl,
                            sessionToken: realmSession.sessionToken,
                        }, ({ position, avgWaitSeconds }) => {
                            this.messageBoxApi.show(this.strings.get("TS:ServerFull") +
                                "\n\n\n" +
                                this.strings.get("TS:LoginPositionInQueue", position) +
                                "\n" +
                                this.strings.get("TS:LoginAvgWaitTime") +
                                (avgWaitSeconds > 0 && avgWaitSeconds < 3600
                                    ? this.strings.get("TS:LoginAvgWaitTimeMinutes", avgWaitSeconds < 60 ? "<1" : "~" + Math.ceil(avgWaitSeconds / 60))
                                    : this.strings.get("TS:LoginAvgWaitTimeUnavail")), this.strings.get("GUI:Cancel"), () => {
                                queueCancelled = true;
                                this.sessionService.clearRealmSession();
                            });
                        });
                    this.wladderService.setUrl(realm.wladderUrl);
                    this.wgameresService.setUrl(realm.wgameresUrl);
                    this.errorReportService.setUrl(realm.errorReportUrl);
                    this.mapTransferService.setUrl(realm.mapTransferUrl);
                    this.messageBoxApi.destroy();
                    const route = this.params.afterLogin(messages);
                    if (route instanceof MainMenuRoute) {
                        this.controller?.goToScreen(route.screenType, route.params);
                    }
                    else {
                        this.rootController.goToScreen(route.screenType, route.params);
                    }
                }
                catch (error) {
                    this.messageBoxApi.destroy();
                    this.sessionService.clearRealmSession();
                    if (queueCancelled) {
                        this.isBusy = false;
                        this.updateSidebarButtons();
                        this.controller?.showSidebarButtons();
                        return;
                    }
                    if (error instanceof DownloadError && error.statusCode === 401) {
                        this.sessionService.clearAccount();
                        this.controller?.goToScreen(ScreenType.Login, this.params);
                        return;
                    }
                    const message = error instanceof WolError && error.code === WolError.Code.OutdatedClient
                        ? this.strings.get("TS:OutdatedClient")
                        : this.strings.get("TS:ConnectFailed");
                    this.errorHandler.handle(error, message, () => {
                        this.isBusy = false;
                        this.updateSidebarButtons();
                        this.controller?.showSidebarButtons();
                    });
                }
            }
            else {
                this.controller?.goToScreen(ScreenType.RealmSelection, this.params);
            }
        }
    }

    private async runNicknameListTask(autoLoginNickname?: string): Promise<void> {
        let cancellationToken: CancellationToken | undefined;
        const task = this.nicknameListTask = new Task<void>(ct => {
            cancellationToken = ct;
            return this.loadNicknameList(ct, autoLoginNickname);
        });
        let isShowingConnecting = false;
        const timeout = setTimeout(() => {
            if (!cancellationToken?.isCancelled()) {
                this.messageBoxApi.show(this.strings.get("TXT_CONNECTING"));
                isShowingConnecting = true;
            }
        }, 1000);
        try {
            await task.start();
        }
        finally {
            clearTimeout(timeout);
            if (isShowingConnecting) {
                this.messageBoxApi.destroy();
            }
            if (this.nicknameListTask === task) {
                this.nicknameListTask = undefined;
            }
        }
    }

    private async loadNicknameList(cancellationToken: CancellationToken, autoLoginNickname?: string): Promise<void> {
        const realm = this.sessionService.getSelectedRealm();
        if (!realm) {
            return;
        }
        const { nicknames, maxNicknames } = await this.realmService.loadNicknames(realm.id, cancellationToken);
        if (cancellationToken.isCancelled()) {
            return;
        }
        this.nicknames = nicknames;
        this.maxNicknames = maxNicknames;
        const realmSession = this.sessionService.getRealmSession();
        const preferredNickname = autoLoginNickname ?? this.selectedNickname ?? (realmSession?.realmId === realm.id ? realmSession.nickname : undefined);
        this.selectedNickname = preferredNickname && nicknames.includes(preferredNickname) ? preferredNickname : nicknames[0];
        this.nicknameBox?.applyOptions((options: any) => {
            options.nicknames = nicknames;
            options.maxNicknames = maxNicknames;
            options.selectedNickname = this.selectedNickname;
        });
        this.nicknameBox?.refresh();
    }

    async onLeave(): Promise<void> {
        this.nicknameCreateTask?.cancel();
        this.nicknameCreateTask = undefined;
        this.nicknameListTask?.cancel();
        this.nicknameListTask = undefined;
        this.nicknameBox = undefined;
        if (!this.isBusy) {
            await this.controller?.hideSidebarButtons();
        }
        this.isBusy = false;
    }
}
