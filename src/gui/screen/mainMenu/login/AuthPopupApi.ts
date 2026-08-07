import { AUTH_POPUP_COMPLETE_MESSAGE_TYPE } from "@/network/authConfig";

export interface AuthProvider {
    id: string;
    loginUrl: string;
}

export class AuthPopupApi {
    private messageHandler?: (event: MessageEvent) => void;

    constructor(private locale: string) {
    }

    open(provider: AuthProvider, onComplete: () => void): boolean {
        const left = Math.round(window.screenX + Math.max(0, (window.outerWidth - 520) / 2));
        const top = Math.round(window.screenY + Math.max(0, (window.outerHeight - 720) / 2));
        const loginUrl = this.getLoginUrl(provider);
        const popup = window.open(loginUrl, "chronodivide-auth-" + provider.id, `width=520,height=720,left=${left},top=${top}`);
        if (!popup) {
            return false;
        }
        this.dispose();
        const origin = new URL(loginUrl, window.location.href).origin;
        this.messageHandler = (event: MessageEvent) => {
            if (event.origin === origin && this.isCompleteMessage(event.data)) {
                this.dispose();
                onComplete();
            }
        };
        window.addEventListener("message", this.messageHandler);
        popup.focus();
        return true;
    }

    getLoginUrl(provider: AuthProvider, returnUrl?: string): string {
        const url = new URL(provider.loginUrl, window.location.href);
        url.searchParams.set("locale", this.locale);
        if (returnUrl) {
            url.searchParams.set("returnUrl", returnUrl);
        }
        return url.toString();
    }

    dispose(): void {
        if (this.messageHandler) {
            window.removeEventListener("message", this.messageHandler);
            this.messageHandler = undefined;
        }
    }

    private isCompleteMessage(data: any): boolean {
        return !!data && typeof data === "object" && data.type === AUTH_POPUP_COMPLETE_MESSAGE_TYPE;
    }
}
