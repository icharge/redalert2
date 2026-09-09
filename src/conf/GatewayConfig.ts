import type { IniSection } from '@/data/IniSection';

export class GatewayConfig {
    public baseUrl!: string;
    public realmListUrl!: string;
    public realmsUrl!: string;
    public authSessionUrl!: string;
    public authCsrfUrl!: string;
    public authLogoutUrl!: string;

    load(section: IniSection): void {
        const baseUrl = section.getString("baseUrl");
        if (!baseUrl) {
            throw new Error("Missing [Gateway] baseUrl");
        }
        this.baseUrl = this.withTrailingSlash(baseUrl);
        this.realmListUrl = section.getString("realmListUrl", this.baseUrl + "realms");
        this.realmsUrl = this.withTrailingSlash(section.getString("realmsUrl", this.baseUrl + "realms/"));
        this.authSessionUrl = section.getString("authSessionUrl", this.baseUrl + "auth/session");
        this.authCsrfUrl = section.getString("authCsrfUrl", this.baseUrl + "auth/csrf");
        this.authLogoutUrl = section.getString("authLogoutUrl", this.baseUrl + "auth/logout");
    }

    getAuthProviderLoginUrl(providerId: string): string {
        return `${this.baseUrl}auth/providers/${encodeURIComponent(providerId)}/login`;
    }

    private withTrailingSlash(url: string): string {
        return url.endsWith("/") ? url : url + "/";
    }
}
