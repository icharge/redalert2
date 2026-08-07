import { EventDispatcher } from "@/util/event";
import { ResourceLoader } from "@/engine/ResourceLoader";
import { IniFile } from "@/data/IniFile";
import { WolError } from "@/network/WolError";
import { localeCodeMap } from "@/network/WolLocale";
import { IrcConnection } from "@/network/IrcConnection";
import { HttpRequest } from "@/network/HttpRequest";
import { AccountLoginErrorCode } from "@/network/AccountLoginFormData";
import { WolConfig } from "@/network/WolConfig";
import { WolConnection } from "@/network/WolConnection";
import { WolGameReport } from "@/network/WolGameReport";
import type { Region } from "@/network/ServerRegions";

export interface WolConnectOptions {
    url: string;
    sessionToken: string;
}

export interface WolLoginResult {
    user: string;
    sessionToken: string;
    claimToken?: string;
}

export class WolService {
    static MIN_RECONNECT_MILLIS = 5_000;
    static MAX_RECONNECT_MILLIS = 60_000;

    private _onWolConnectionLost = new EventDispatcher<WolService, CloseEvent>();
    private connectOpts?: WolConnectOptions;
    private ignoreLastWolClose = false;
    private autoReconnect = false;
    private pendingReconnect = false;
    private reconnectTimeout?: any;
    private lastGameReport?: WolGameReport;

    get onWolConnectionLost() {
        return this._onWolConnectionLost.asEvent();
    }

    constructor(
        private wolConfig: WolConfig,
        private wolCon: WolConnection,
        private clientVersion: string,
        private clientLocale: string,
        private httpRequest: HttpRequest = new HttpRequest(),
    ) {
        this.onWolClose = (event: CloseEvent) => {
            if (this.connectOpts && !this.ignoreLastWolClose) {
                if (this.autoReconnect && !this.pendingReconnect) {
                    this.reconnectTimeout = setTimeout(() => this.tryReconnect(WolService.MIN_RECONNECT_MILLIS), 0);
                }
                this._onWolConnectionLost.dispatch(this, event);
            }
            this.ignoreLastWolClose = false;
        };
        this.onGameReport = (report: WolGameReport) => {
            this.lastGameReport = report;
        };
    }

    private onWolClose: (event: CloseEvent) => void;
    private onGameReport: (report: WolGameReport) => void;

    init(): void {
        this.wolCon.onGameReport.subscribe(this.onGameReport);
        this.wolCon.onClose.subscribe(this.onWolClose);
    }

    getConfig(): WolConfig {
        return this.wolConfig;
    }

    getConnection(): WolConnection {
        return this.wolCon;
    }

    isConnected(): boolean {
        return this.wolCon.isOpen();
    }

    getSession(): { sessionToken: string } | undefined {
        return this.connectOpts ? {
            sessionToken: this.connectOpts.sessionToken,
        } : undefined;
    }

    getLastGameReport(): WolGameReport | undefined {
        return this.lastGameReport;
    }

    async login(region: Region, user: string, pass: string, turnstileToken?: string): Promise<WolLoginResult> {
        const body = {
            locale: this.clientLocale,
            user,
            pass,
            turnstileToken,
        };
        const response = await this.httpRequest.fetchJson(region.apiLoginUrl, undefined, {
            method: "POST",
            body: JSON.stringify(body),
        });
        if (response.error === undefined) {
            return response;
        }
        const { error, errorCode } = response;
        const code = errorCode === AccountLoginErrorCode.TurnstileVerificationFailed
            ? WolError.Code.TurnstileVerificationFailed
            : errorCode === AccountLoginErrorCode.BannedFromServer
                ? WolError.Code.BannedFromServer
                : WolError.Code.BadLogin;
        throw new WolError("Login error: " + error, code, error);
    }

    async connect(options: WolConnectOptions, onQueueUpdate?: any): Promise<{ text: string }[]> {
        this.cancelReconnect();
        if (this.wolCon.isOpen() && JSON.stringify(this.connectOpts) !== JSON.stringify(options)) {
            this.closeWolConnection();
        }
        this.connectOpts = options;
        this.ignoreLastWolClose = true;
        try {
            await this.wolCon.connect(options.url);
            await this.wolCon.cvers(this.clientVersion, this.wolConfig.getClientSku());
            const locale = this.clientLocale !== undefined ? localeCodeMap.get(this.clientLocale) : undefined;
            if (locale !== undefined) {
                await this.wolCon.setLocale(locale);
            }
            const messages = await this.wolCon.authenticate(options.sessionToken, onQueueUpdate);
            this.ignoreLastWolClose = false;
            return messages.map(message => ({
                text: message,
            }));
        }
        catch (error) {
            if (error instanceof WolError && error.code === WolError.Code.BadSession) {
                this.connectOpts = undefined;
            }
            if (!(error instanceof WolError) &&
                !(error instanceof IrcConnection.ConnectError) &&
                !(error instanceof IrcConnection.SocketError)) {
                this.ignoreLastWolClose = false;
            }
            throw error;
        }
    }

    async loadServerList(url: string, cancellationToken?: any): Promise<IniFile> {
        const resourceLoader = new ResourceLoader("");
        const text = await resourceLoader.loadText(url, cancellationToken);
        return new IniFile().fromString(text);
    }

    async createAccount(region: Region, user: string, pass: string, turnstileToken?: string): Promise<any> {
        const body = {
            locale: this.clientLocale,
            user,
            pass,
            turnstileToken,
        };
        return await this.httpRequest.fetchJson(region.apiRegUrl, undefined, {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    validateGameVersion(region: Region): boolean {
        if (region.gameVersion && !this.matchVersions(this.clientVersion, region.gameVersion)) {
            console.warn("Game version mismatch: " + `client version is ${this.clientVersion}, but expected ` + region.gameVersion);
            return false;
        }
        return true;
    }

    private matchVersions(clientVersion: string, expectedVersion: string): boolean {
        const [clientMajor, clientMinor, clientPatch] = clientVersion.split(".");
        const [expectedMajor, expectedMinor, expectedPatch] = expectedVersion.split(".");
        return clientMajor === expectedMajor && clientMinor === expectedMinor && Number(clientPatch.split("-")[0]) >= Number(expectedPatch);
    }

    async tryReconnect(delayMillis: number): Promise<void> {
        if (!this.connectOpts || this.pendingReconnect) {
            return;
        }
        try {
            this.pendingReconnect = true;
            await this.connect(this.connectOpts);
            await this.wolCon.rejoinLastChannels();
        }
        catch (error) {
            if (error instanceof WolError) {
                console.error("Failed to reconnect to WoL service", error);
                if (error.code === WolError.Code.BadSession) {
                    this.connectOpts = undefined;
                    this.cancelReconnect();
                    console.warn("Session is invalid or expired. Will no longer attempt to reconnect.", error);
                }
            }
            else {
                const nextDelay = Math.min(WolService.MAX_RECONNECT_MILLIS, 2 * delayMillis);
                this.reconnectTimeout = setTimeout(() => this.tryReconnect(nextDelay), delayMillis);
            }
        }
        finally {
            this.pendingReconnect = false;
        }
    }

    setAutoReconnect(autoReconnect: boolean): void {
        if (autoReconnect !== this.autoReconnect) {
            this.autoReconnect = autoReconnect;
            if (!autoReconnect) {
                this.cancelReconnect();
            }
        }
    }

    closeWolConnection(): void {
        this.cancelReconnect();
        this.connectOpts = undefined;
        if (this.wolCon.isOpen()) {
            this.ignoreLastWolClose = true;
            this.wolCon.leaveAllChannels();
            this.wolCon.close();
        }
    }

    dispose(): void {
        this.cancelReconnect();
        this.wolCon.onGameReport.unsubscribe(this.onGameReport);
        this.wolCon.onClose.unsubscribe(this.onWolClose);
    }

    private cancelReconnect(): void {
        if (this.pendingReconnect) {
            this.wolCon.close();
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
    }
}
