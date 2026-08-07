import { Task } from "@puzzl/core/lib/async/Task";
import { OperationCanceledError, CancellationToken } from "@puzzl/core/lib/async/cancellation";
import { jsx } from "@/gui/jsx/jsx";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { DownloadError } from "@/network/HttpRequest";
import { ServerRegions } from "@/network/ServerRegions";
import { StorageKey, LocalPrefs } from "@/LocalPrefs";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { ScreenType } from "@/gui/screen/mainMenu/ScreenType";
import { RealmSelectionBox } from "@/gui/screen/mainMenu/realmSelection/RealmSelectionBox";
import type { MainMenuRoute } from "@/gui/screen/mainMenu/MainMenuRoute";
import type { Realm } from "@/network/Realm";
import type { RealmService } from "@/network/RealmService";
import type { SessionService } from "@/network/SessionService";
import type { AuthService } from "@/network/AuthService";
import type { ErrorHandler } from "@/ErrorHandler";
import type { MessageBoxApi } from "@/gui/component/MessageBoxApi";

interface RealmSelectionBoxApi {
    applyOptions(update: (options: any) => void): void;
    refresh(): void;
}

interface RealmSelectionScreenParams {
    autoLoginNickname?: string;
    afterLogin: (messages: any[]) => MainMenuRoute | { screenType: any; params: any };
    [key: string]: any;
}

export class RealmSelectionScreen extends MainMenuScreen {
    private strings: any;
    private jsxRenderer: any;
    private errorHandler: ErrorHandler;
    private localPrefs: LocalPrefs;
    private authService: AuthService;
    private realmService: RealmService;
    private sessionService: SessionService;
    private messageBoxApi: MessageBoxApi;
    private breakingNewsUrl: string;
    private realmList: ServerRegions = new ServerRegions();
    private selectedRealm?: Realm;
    private realmBox?: RealmSelectionBoxApi;
    private realmListTask?: Task<void>;
    private isBusy: boolean = false;
    private params!: RealmSelectionScreenParams;
    private handleRealmChange: (realmId: string) => void;
    private handleRealmDoubleClick: (realmId: string) => void;
    private updateRealms: () => Promise<void>;

    constructor(strings: any, jsxRenderer: any, errorHandler: ErrorHandler, localPrefs: LocalPrefs, authService: AuthService, realmService: RealmService, sessionService: SessionService, messageBoxApi: MessageBoxApi, breakingNewsUrl: string) {
        super();
        this.strings = strings;
        this.jsxRenderer = jsxRenderer;
        this.errorHandler = errorHandler;
        this.localPrefs = localPrefs;
        this.authService = authService;
        this.realmService = realmService;
        this.sessionService = sessionService;
        this.messageBoxApi = messageBoxApi;
        this.breakingNewsUrl = breakingNewsUrl;
        this.title = this.strings.get("TS:Region");
        this.isBusy = false;
        this.realmList = new ServerRegions();
        this.handleRealmChange = (realmId: string) => {
            this.selectedRealm = this.realmList.get(realmId);
            this.realmBox?.applyOptions((options: any) => (options.selectedRealm = this.selectedRealm));
            this.realmBox?.refresh();
            this.updateSidebarButtons();
        };
        this.handleRealmDoubleClick = (realmId: string) => {
            this.handleRealmChange(realmId);
            this.handleContinue();
        };
        this.updateRealms = async () => {
            if (!this.isBusy) {
                this.isBusy = true;
                this.updateSidebarButtons();
                try {
                    await this.runRealmListTask();
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
                    if (error instanceof DownloadError && error.statusCode === 409) {
                        this.errorHandler.handle(error, this.strings.get("TS:OutdatedClient"), () => this.controller?.goToScreen(ScreenType.Home));
                        return;
                    }
                    this.errorHandler.handle(error, this.strings.get("TXT_NO_SERV_LIST"), () => {
                        this.isBusy = false;
                        this.updateSidebarButtons();
                    });
                }
            }
        };
    }

    async onEnter(params: RealmSelectionScreenParams): Promise<void> {
        this.params = params;
        this.controller.toggleMainVideo(false);
        if (this.sessionService.getAccount()) {
            const preferredRegion = this.localPrefs.getItem(StorageKey.PreferredServerRegion);
            const preferredNickname = this.selectedRealm || this.sessionService.getSelectedRealm() ? undefined : this.localPrefs.getItem(StorageKey.PreferredNickname);
            try {
                await this.runRealmListTask();
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
                if (error instanceof DownloadError && error.statusCode === 409) {
                    this.errorHandler.handle(error, this.strings.get("TS:OutdatedClient"), () => this.controller?.goToScreen(ScreenType.Home));
                    return;
                }
                this.errorHandler.handle(error, this.strings.get("TXT_NO_SERV_LIST"), () => this.controller?.goToScreen(ScreenType.Home));
                return;
            }
            if (preferredNickname && this.selectedRealm?.id === preferredRegion) {
                this.handleContinue(preferredNickname);
            }
            else {
                const [component] = this.jsxRenderer.render(jsx(HtmlView, {
                    width: "100%",
                    height: "100%",
                    component: RealmSelectionBox,
                    props: {
                        breakingNewsUrl: this.breakingNewsUrl,
                        realms: this.realmList.getAll(),
                        selectedRealm: this.selectedRealm,
                        strings: this.strings,
                        onChange: this.handleRealmChange,
                        onDoubleClick: this.handleRealmDoubleClick,
                        onRequestRefresh: this.updateRealms,
                    },
                    innerRef: (ref: RealmSelectionBoxApi) => (this.realmBox = ref),
                }));
                this.controller.setMainComponent(component);
                this.updateSidebarButtons();
                this.controller.showSidebarButtons();
            }
        }
        else {
            this.controller.goToScreen(ScreenType.Login, params);
        }
    }

    private updateSidebarButtons(): void {
        this.controller.setSidebarButtons([
            {
                label: this.strings.get("GUI:Continue"),
                disabled: this.isBusy || !this.selectedRealm?.available,
                onClick: () => this.handleContinue(),
            },
            {
                label: this.strings.get("GUI:Logout"),
                disabled: this.isBusy,
                onClick: () => this.logout(),
            },
            {
                label: this.strings.get("GUI:Back"),
                isBottom: true,
                onClick: () => this.controller?.goToScreen(ScreenType.Home),
            },
        ]);
    }

    private handleContinue(autoLoginNickname?: string): void {
        const realm = this.selectedRealm;
        if (realm?.available) {
            this.sessionService.selectRealm(realm);
            this.localPrefs.setItem(StorageKey.PreferredServerRegion, realm.id);
            this.controller?.goToScreen(ScreenType.NicknameSelection, {
                ...this.params,
                autoLoginNickname,
            });
        }
    }

    private async runRealmListTask(): Promise<void> {
        const task = this.realmListTask = new Task<void>(ct => this.loadRealmList(ct));
        try {
            await task.start();
        }
        finally {
            if (this.realmListTask === task) {
                this.realmListTask = undefined;
            }
        }
    }

    private async loadRealmList(cancellationToken: CancellationToken): Promise<void> {
        let isShowingConnecting = false;
        const timeout = setTimeout(() => {
            if (!cancellationToken.isCancelled()) {
                this.messageBoxApi.show(this.strings.get("TXT_CONNECTING"));
                isShowingConnecting = true;
            }
        }, 1000);
        const preferredRegionId = this.selectedRealm?.id ?? this.sessionService.getSelectedRealm()?.id ?? this.localPrefs.getItem(StorageKey.PreferredServerRegion);
        try {
            const realmList = await this.realmService.loadRealmList(cancellationToken);
            if (cancellationToken.isCancelled()) {
                return;
            }
            this.realmList.loadRealms(realmList);
            this.selectedRealm = preferredRegionId && this.realmList.isAvailable(preferredRegionId) ? this.realmList.get(preferredRegionId) : this.realmList.getFirstAvailable();
            this.realmBox?.applyOptions((options: any) => {
                options.realms = this.realmList.getAll();
                options.selectedRealm = this.selectedRealm;
            });
            this.realmBox?.refresh();
        }
        finally {
            clearTimeout(timeout);
            if (isShowingConnecting) {
                this.messageBoxApi.destroy();
            }
        }
    }

    private async logout(): Promise<void> {
        this.isBusy = true;
        this.updateSidebarButtons();
        try {
            await this.authService.logout();
            this.sessionService.clearAccount();
            this.controller?.goToScreen(ScreenType.Login, this.params);
        }
        catch (error) {
            this.errorHandler.handle(error, this.strings.get("TS:ConnectFailed"), () => {
                this.isBusy = false;
                this.updateSidebarButtons();
            });
        }
    }

    async onLeave(): Promise<void> {
        this.realmListTask?.cancel();
        this.realmListTask = undefined;
        this.realmBox = undefined;
        if (!this.isBusy) {
            await this.controller?.hideSidebarButtons();
        }
        this.isBusy = false;
    }
}
