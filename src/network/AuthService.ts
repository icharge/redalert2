import { HttpRequest } from "@/network/HttpRequest";
import { AUTH_CSRF_HEADER_NAME } from "@/network/authConfig";
import type { GatewayConfig } from "@/conf/GatewayConfig";

export interface AuthSession {
    account?: {
        id: string;
        [key: string]: unknown;
    };
}

export class AuthService {
    constructor(private config: GatewayConfig, private httpRequest: HttpRequest = new HttpRequest()) {
    }

    async getSession(): Promise<AuthSession> {
        return await this.httpRequest.fetchJson<AuthSession>(this.config.authSessionUrl, undefined, {
            credentials: "include",
        });
    }

    async getCsrfToken(): Promise<string> {
        return (await this.httpRequest.fetchJson<{ csrfToken: string }>(this.config.authCsrfUrl, undefined, {
            credentials: "include",
        })).csrfToken;
    }

    async logout(): Promise<void> {
        const csrfToken = await this.getCsrfToken();
        await this.httpRequest.fetchText(this.config.authLogoutUrl, undefined, {
            method: "POST",
            headers: {
                [AUTH_CSRF_HEADER_NAME]: csrfToken,
            },
            credentials: "include",
        });
    }
}
