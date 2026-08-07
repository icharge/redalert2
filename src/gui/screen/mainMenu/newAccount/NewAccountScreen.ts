import { jsx } from "@/gui/jsx/jsx";
import { NewAccountBox } from "@/gui/screen/mainMenu/newAccount/NewAccountBox";
import { ScreenType } from "@/gui/screen/mainMenu/ScreenType";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { Task } from "@puzzl/core/lib/async/Task";
import { sleep } from "@puzzl/core/lib/async/sleep";
import { StorageKey, LocalPrefs } from "@/LocalPrefs";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { DownloadError } from "@/network/HttpRequest";
import { WolService } from "@/network/WolService";
import { ServerRegions, Region } from "@/network/ServerRegions";
import { ErrorHandler } from "@/ErrorHandler";
import { Strings } from "@/data/Strings";
import { JsxRenderer } from "@/gui/jsx/JsxRenderer";
import { MessageBoxApi } from "@/gui/component/MessageBoxApi";
import { CfTurnstile } from "@/util/CfTurnstile";
import { AuthProvidersConfig, AuthProvider } from "@/conf/AuthProvidersConfig";
import { AuthPopupApi } from "@/gui/screen/mainMenu/login/AuthPopupApi";
import { AuthService } from "@/network/AuthService";
import { SessionService } from "@/network/SessionService";
import { AccountLoginErrorCode } from "@/network/AccountLoginFormData";

interface NewAccountFormData {
    user: string;
    pass: string;
    passMatch: boolean;
    regionId: string;
    turnstileToken?: string;
}

interface NewAccountScreenParams {
    regionId?: string;
    serverRegions: ServerRegions;
    afterLogin?: any;
}

interface CreateAccountResponse {
    error?: string;
    errorCode?: AccountLoginErrorCode;
    user?: string;
    sessionToken?: string;
}

export class NewAccountScreen extends MainMenuScreen {
    private wolService: WolService;
    private strings: Strings;
    private jsxRenderer: JsxRenderer;
    private messageBoxApi: MessageBoxApi;
    private errorHandler: ErrorHandler;
    private localPrefs: LocalPrefs;
    private cfTurnstile: CfTurnstile;
    private legacyRegistrationEnabled: boolean;
    private authProvidersConfig: AuthProvidersConfig;
    private authPopupApi: AuthPopupApi;
    private authService?: AuthService;
    private sessionService: SessionService;
    private params!: NewAccountScreenParams;
    private newAccountBox?: any;
    private isBusy: boolean = false;
    private turnstileToken?: string;

    constructor(wolService: WolService, strings: Strings, jsxRenderer: JsxRenderer, messageBoxApi: MessageBoxApi, errorHandler: ErrorHandler, localPrefs: LocalPrefs, cfTurnstile: CfTurnstile, legacyRegistrationEnabled: boolean, authProvidersConfig: AuthProvidersConfig, authPopupApi: AuthPopupApi, authService: AuthService | undefined, sessionService: SessionService) {
        super();
        this.wolService = wolService;
        this.strings = strings;
        this.jsxRenderer = jsxRenderer;
        this.messageBoxApi = messageBoxApi;
        this.errorHandler = errorHandler;
        this.localPrefs = localPrefs;
        this.cfTurnstile = cfTurnstile;
        this.legacyRegistrationEnabled = legacyRegistrationEnabled;
        this.authProvidersConfig = authProvidersConfig;
        this.authPopupApi = authPopupApi;
        this.authService = authService;
        this.sessionService = sessionService;
        this.title = this.strings.get("GUI:NewAccount");
        this.handleSubmit = async (formData: NewAccountFormData, afterLogin?: any) => {
            if (!this.isBusy && this.controller) {
                this.isBusy = true;
                await this.controller.hideSidebarButtons();
                const { user, pass, passMatch, turnstileToken, regionId } = formData;
                if (!this.cfTurnstile.isEnabled() || turnstileToken) {
                    if (passMatch) {
                        if (user.match(/^[A-Za-z0-9-_]+$/)) {
                            const region = this.params.serverRegions.get(regionId);
                            await this.createAccount(user, pass, region, turnstileToken, afterLogin);
                        }
                        else {
                            this.handleValidationError(this.strings.get("TS:BadNickname"));
                        }
                    }
                    else {
                        this.handleValidationError(this.strings.get("TXT_PASSWORD_VERIFY"));
                    }
                }
                else {
                    this.handleValidationError(this.strings.get("TS:TurnstileFailed"));
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

    private handleSubmit: (formData: NewAccountFormData, afterLogin?: any) => Promise<void>;
    private handleAuthProviderLogin: (provider: AuthProvider) => void;
    private handleAuthProviderComplete: () => Promise<void>;

    async onEnter(params: NewAccountScreenParams): Promise<void> {
        this.params = params;
        this.controller.toggleMainVideo(false);
        this.isBusy = false;
        this.turnstileToken = undefined;
        if (this.sessionService.getAccount()) {
            this.goToRealmSelection();
            return;
        }
        const savedRegionId = params.regionId ?? this.localPrefs.getItem(StorageKey.PreferredServerRegion);
        const selectedRegion = savedRegionId && params.serverRegions.isAvailable(savedRegionId)
            ? params.serverRegions.get(savedRegionId)
            : params.serverRegions.getFirstAvailable();
        if (selectedRegion) {
            this.updateSidebarButtons();
            this.controller.showSidebarButtons();
            const [component] = this.jsxRenderer.render(jsx(HtmlView, {
                width: "100%",
                height: "100%",
                component: NewAccountBox,
                props: {
                    ref: (ref: any) => (this.newAccountBox = ref),
                    strings: this.strings,
                    regions: params.serverRegions.getAll(),
                    initialRegion: selectedRegion,
                    authProviders: this.authProvidersConfig.getAll(),
                    legacyRegistrationEnabled: this.legacyRegistrationEnabled,
                    cfTurnstile: this.cfTurnstile,
                    onRegionChange: (regionId: string) => {
                        this.localPrefs.setItem(StorageKey.PreferredServerRegion, regionId);
                    },
                    onTurnstileTokenChange: (token?: string) => {
                        this.turnstileToken = token;
                        this.updateSidebarButtons();
                    },
                    onSubmit: (formData: NewAccountFormData) => this.handleSubmit(formData, params.afterLogin),
                    onAuthProviderLogin: this.handleAuthProviderLogin,
                },
            }));
            this.controller.setMainComponent(component);
        }
        else {
            this.handleWolError("No servers available", this.strings.get("gui:noserversavailable"), { fatal: true });
        }
    }

    private updateSidebarButtons(): void {
        if (!this.controller) {
            return;
        }
        this.controller.setSidebarButtons([
            ...(this.legacyRegistrationEnabled ? [{
                label: this.strings.get("GUI:Ok"),
                disabled: this.cfTurnstile.isEnabled() && !this.turnstileToken,
                onClick: () => this.submitForm(),
            }] : []),
            {
                label: this.strings.get("GUI:Back"),
                isBottom: true,
                onClick: () => {
                    this.controller?.goToScreen(ScreenType.Login, {
                        afterLogin: this.params.afterLogin,
                    });
                },
            },
        ]);
    }

    private submitForm(): void {
        if (!this.isBusy && this.controller && this.newAccountBox?.submit) {
            this.newAccountBox.submit();
        }
    }
    private goToRealmSelection(): void {
        this.controller?.goToScreen(ScreenType.RealmSelection, {
            afterLogin: this.params.afterLogin,
        });
    }

    private async createAccount(user: string, pass: string, region: Region, turnstileToken: string | undefined, afterLogin?: any): Promise<void> {
        const connectingTask = new Task<void>(async (cancellationToken) => {
            await sleep(1000, cancellationToken);
            if (!cancellationToken.isCancelled()) {
                this.messageBoxApi.show(this.strings.get("TXT_CONNECTING"));
            }
        });
        connectingTask.start();
        try {
            const response = await this.wolService.createAccount(region, user, pass, turnstileToken) as CreateAccountResponse;
            connectingTask.cancel();
            this.messageBoxApi.destroy();
            if (response.error !== undefined) {
                if (response.errorCode === AccountLoginErrorCode.BannedFromServer) {
                    this.handleValidationError(response.error || this.strings.get("TS:AccountBanned"));
                }
                else {
                    this.handleValidationError(response.error);
                }
                return;
            }
            this.sessionService.selectRealm(region);
            this.sessionService.setRealmSession({
                realmId: region.id,
                nickname: response.user!,
                sessionToken: response.sessionToken!,
            });
            this.controller?.goToScreen(ScreenType.Login, {
                afterLogin,
            });
        }
        catch (error) {
            connectingTask.cancel();
            this.messageBoxApi.destroy();
            this.handleWolError(error, this.strings.get("TS:ConnectFailed"), {
                fatal: false,
            });
        }
    }

    private handleValidationError(message: string): void {
        this.messageBoxApi.show(message, this.strings.get("GUI:Ok"), () => {
            this.isBusy = false;
            this.turnstileToken = undefined;
            this.newAccountBox?.resetTurnstile();
            this.controller?.showSidebarButtons();
            this.updateSidebarButtons();
        });
    }

    private handleWolError(error: any, message: string, { fatal }: {
        fatal: boolean;
    }): void {
        this.errorHandler.handle(error, message, () => {
            this.isBusy = false;
            if (this.controller) {
                if (fatal) {
                    this.controller.goToScreen(ScreenType.Home);
                }
                else {
                    this.turnstileToken = undefined;
                    this.newAccountBox?.resetTurnstile();
                    this.controller.showSidebarButtons();
                }
            }
        });
    }

    async onLeave(): Promise<void> {
        this.newAccountBox = undefined;
        this.authPopupApi.dispose();
        if (!this.isBusy && this.controller) {
            await this.controller.hideSidebarButtons();
        }
        this.isBusy = false;
    }
}
