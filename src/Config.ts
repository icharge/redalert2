import { IniFile } from './data/IniFile';
import { IniSection } from './data/IniSection';
import { AuthProvidersConfig } from './conf/AuthProvidersConfig';
import { GatewayConfig } from './conf/GatewayConfig';
interface ViewportConfig {
    width: number;
    height: number;
}
interface SentryConfig {
    dsn: string;
    env: string;
    defaultIntegrations: boolean;
    lazyLoad: boolean;
}
interface TurnstileConfig {
    siteKey: string;
    scriptUrl: string;
    enabledForLogin: boolean;
    preClearanceEnabled: boolean;
    theme: string;
    size: string;
}
export class Config {
    private generalData!: IniSection;
    public viewport!: ViewportConfig;
    public sentry?: SentryConfig;
    public turnstile?: TurnstileConfig;
    public gateway?: GatewayConfig;
    public authProviders: AuthProvidersConfig = new AuthProvidersConfig();
    public corsProxies: [
        string,
        string
    ][] = [];
    static DEFAULT_TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    constructor() {
        this.corsProxies = [];
    }
    public load(iniFile: IniFile): void {
        const generalSection = iniFile.getSection("General");
        if (!generalSection) {
            throw new Error("Missing [General] section in application config");
        }
        this.generalData = generalSection;
        this.viewport = {
            width: generalSection.getNumber("viewport.width"),
            height: generalSection.getNumber("viewport.height"),
        };
        const sentrySection = iniFile.getSection("Sentry");
        if (sentrySection) {
            this.sentry = {
                dsn: sentrySection.getString("dsn"),
                env: sentrySection.getString("env"),
                defaultIntegrations: sentrySection.getBool("defaultIntegrations"),
                lazyLoad: sentrySection.getBool("lazyLoad", true),
            };
        }
        const turnstileSection = iniFile.getSection("Turnstile");
        if (turnstileSection) {
            this.turnstile = {
                siteKey: turnstileSection.getString("siteKey"),
                scriptUrl: turnstileSection.getString("scriptUrl", Config.DEFAULT_TURNSTILE_SCRIPT_URL),
                enabledForLogin: turnstileSection.getBool("enabledForLogin"),
                preClearanceEnabled: turnstileSection.getBool("preClearanceEnabled"),
                theme: turnstileSection.getString("theme", "dark"),
                size: turnstileSection.getString("size", "normal"),
            };
            if (!this.turnstile.siteKey) {
                throw new Error("Missing [Turnstile] siteKey");
            }
        }
        const gatewaySection = iniFile.getSection("Gateway");
        if (gatewaySection) {
            this.gateway = new GatewayConfig();
            this.gateway.load(gatewaySection);
        }
        if (this.gateway) {
            this.authProviders.load(iniFile.getSection("AuthProvider"), this.gateway);
        }
        const corsProxySection = iniFile.getSection("CorsProxy");
        if (corsProxySection) {
            this.corsProxies = [];
            corsProxySection.entries.forEach((value, key) => {
                if (typeof value === 'string') {
                    this.corsProxies.push([key, value]);
                }
                else if (Array.isArray(value)) {
                    console.warn(`[Config] CorsProxy key '${key}' has an array value, using first entry: ${value[0]}`);
                    this.corsProxies.push([key, value[0]]);
                }
            });
        }
    }
    public getGeneralData(): IniSection {
        if (!this.generalData) {
            console.warn("[Config] getGeneralData called before config was properly loaded. Returning empty section.");
            return new IniSection("General");
        }
        return this.generalData;
    }
    get defaultLocale(): string {
        return this.generalData.getString("defaultLanguage", "en-US");
    }
    get serversUrl(): string {
        return this.generalData.getString("serversUrl", "servers.ini");
    }
    get gameresBaseUrl(): string | undefined {
        const url = this.generalData.getString("gameresBaseUrl");
        return url === "" ? undefined : url;
    }
    get gameResArchiveUrl(): string | undefined {
        const url = this.generalData.getString("gameResArchiveUrl");
        return url === "" ? undefined : url;
    }
    get checkMixesIntegrity(): boolean {
        return this.generalData.getBool("checkMixesIntegrity", true);
    }
    get mapsBaseUrl(): string | undefined {
        const url = this.generalData.getString("mapsBaseUrl");
        return url === "" ? undefined : url;
    }
    get mapsPktUrl(): string | undefined {
        const url = this.generalData.getString("mapsPktUrl");
        return url === "" ? undefined : url;
    }
    get modsBaseUrl(): string | undefined {
        const url = this.generalData.getString("modsBaseUrl");
        return url === "" ? undefined : url;
    }
    get devMode(): boolean {
        return this.generalData.getBool("dev");
    }
    get discordUrl(): string | undefined {
        const url = this.generalData.getString("discordUrl");
        return url.length > 0 ? url : undefined;
    }
    get patchNotesUrl(): string | undefined {
        const url = this.generalData.getString("patchNotesUrl");
        return url.length > 0 ? url : undefined;
    }
    get ladderRulesUrl(): string | undefined {
        const url = this.generalData.getString("ladderRulesUrl");
        return url.length > 0 ? url : undefined;
    }
    get modSdkUrl(): string | undefined {
        const url = this.generalData.getString("modSdkUrl");
        return url.length > 0 ? url : undefined;
    }
    get breakingNewsUrl(): string | undefined {
        const url = this.generalData.getString("breakingNewsUrl");
        return url.length > 0 ? url : undefined;
    }
    get quickMatchEnabled(): boolean {
        return this.generalData.getBool("quickMatchEnabled");
    }
    get legacyRegistrationEnabled(): boolean {
        return this.generalData.getBool("legacyRegistrationEnabled");
    }
    get unrankedQueueEnabled(): boolean {
        return this.generalData.getBool("unrankedQueueEnabled", true);
    }
    get botsEnabled(): boolean {
        return this.generalData.getBool("botsEnabled");
    }
    get oldClientsBaseUrl(): string | undefined {
        const url = this.generalData.getString("oldClientsBaseUrl");
        return url.length > 0 ? url : undefined;
    }
    get debugGameState(): boolean {
        return this.generalData.getBool("debugGameState");
    }
    get debugLogging(): boolean | string | undefined {
        const strVal = this.generalData.getString("debugLogging");
        if (strVal === "")
            return undefined;
        const boolVal = this.generalData.getBool("debugLogging");
        if (boolVal)
            return true;
        if (strVal.toLowerCase() === 'false' || strVal === '0' || strVal.toLowerCase() === 'no' || strVal.toLowerCase() === 'off')
            return false;
        return strVal;
    }
    public getCorsProxy(urlToMatch: string): string | undefined {
        let wildcardProxy: string | undefined = undefined;
        for (const [pattern, proxyUrl] of this.corsProxies) {
            if (pattern.startsWith(".")) {
                if (urlToMatch.endsWith(pattern)) {
                    return proxyUrl;
                }
            }
            else if (pattern === "*") {
                wildcardProxy = proxyUrl;
            }
            else {
                if (urlToMatch === pattern) {
                    return proxyUrl;
                }
            }
        }
        return wildcardProxy;
    }
}
