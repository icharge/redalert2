import { AUTH_CSRF_HEADER_NAME } from "@/network/authConfig";
import { HttpRequest } from "@/network/HttpRequest";
import { AuthService } from "@/network/AuthService";
import type { GatewayConfig } from "@/conf/GatewayConfig";
import type { Realm } from "@/network/Realm";
import type { CreateRealmSessionRequest } from "@/network/CreateRealmSessionRequest";
import type { CreateRealmSessionResponse } from "@/network/CreateRealmSessionResponse";
import type { ClaimNicknameRequest } from "@/network/ClaimNicknameRequest";
import type { ClaimNicknameResponse } from "@/network/ClaimNicknameResponse";
import type { CreateNicknameRequest } from "@/network/CreateNicknameRequest";
import type { CreateNicknameResponse } from "@/network/CreateNicknameResponse";
import type { NicknameListResponse } from "@/network/NicknameListResponse";
import type { CancellationToken } from "@puzzl/core/lib/async/cancellation";

export class RealmService {
    constructor(
        private config: GatewayConfig,
        private gameSku: number,
        private clientVersion: string,
        private clientLocale: string,
        private authService: AuthService,
        private httpRequest: HttpRequest = new HttpRequest(),
    ) {
    }

    async loadRealmList(cancellationToken?: CancellationToken): Promise<Realm[]> {
        const url = new URL(this.config.realmListUrl, window.location.href);
        url.searchParams.set("gameSku", this.gameSku.toString());
        url.searchParams.set("clientVersion", this.clientVersion);
        return (await this.httpRequest.fetchJson<{ realms: Realm[] }>(url.toString(), cancellationToken, {
            credentials: "include",
        })).realms;
    }

    async createSession(realmId: string, nickname: string): Promise<CreateRealmSessionResponse> {
        const csrfToken = await this.authService.getCsrfToken();
        const body: CreateRealmSessionRequest = {
            gameSku: this.gameSku,
            nickname,
            locale: this.clientLocale,
        };
        return await this.httpRequest.fetchJson<CreateRealmSessionResponse>(
            new URL(encodeURIComponent(realmId) + "/sessions", new URL(this.config.realmsUrl, window.location.href)).toString(),
            undefined,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    [AUTH_CSRF_HEADER_NAME]: csrfToken,
                },
                body: JSON.stringify(body),
                credentials: "include",
            });
    }

    async loadNicknames(realmId: string, cancellationToken?: CancellationToken): Promise<NicknameListResponse> {
        return await this.httpRequest.fetchJson<NicknameListResponse>(
            new URL(encodeURIComponent(realmId) + "/nicknames", new URL(this.config.realmsUrl, window.location.href)).toString(),
            cancellationToken,
            {
                credentials: "include",
            });
    }

    async createNickname(realmId: string, nickname: string, cancellationToken?: CancellationToken): Promise<CreateNicknameResponse> {
        const csrfToken = await this.authService.getCsrfToken();
        const body: CreateNicknameRequest = {
            nickname,
            locale: this.clientLocale,
        };
        return await this.httpRequest.fetchJson<CreateNicknameResponse>(
            new URL(encodeURIComponent(realmId) + "/nicknames", new URL(this.config.realmsUrl, window.location.href)).toString(),
            cancellationToken,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    [AUTH_CSRF_HEADER_NAME]: csrfToken,
                },
                body: JSON.stringify(body),
                credentials: "include",
            });
    }

    async claimNickname(realmId: string, claimToken: string): Promise<ClaimNicknameResponse> {
        const csrfToken = await this.authService.getCsrfToken();
        const body: ClaimNicknameRequest = {
            claimToken,
            locale: this.clientLocale,
        };
        return await this.httpRequest.fetchJson<ClaimNicknameResponse>(
            new URL(encodeURIComponent(realmId) + "/nicknames/claim", new URL(this.config.realmsUrl, window.location.href)).toString(),
            undefined,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    [AUTH_CSRF_HEADER_NAME]: csrfToken,
                },
                body: JSON.stringify(body),
                credentials: "include",
            });
    }
}
