import { ScriptLoader } from "@/util/ScriptLoader";

export interface CfTurnstileConfig {
    siteKey: string;
    scriptUrl: string;
    enabledForLogin: boolean;
    preClearanceEnabled: boolean;
    theme: string;
    size: string;
}

export interface CfTurnstileCallbacks {
    onToken: (token: string) => void;
    onTokenExpired: () => void;
    onError: () => void;
}

interface TurnstileRenderOptions {
    sitekey: string;
    action: string;
    theme: string;
    size: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
}

interface TurnstileApi {
    render(element: HTMLElement, options: TurnstileRenderOptions): string;
    reset(widgetId: string): void;
    remove(widgetId: string): void;
}

export class CfTurnstile {
    private turnstile?: TurnstileApi;
    private loadPromise?: Promise<void>;

    constructor(private config?: CfTurnstileConfig, private document: Document = globalThis.document) {
    }

    isEnabled(): boolean {
        return !!this.config;
    }

    isEnabledForLogin(): boolean {
        return !!this.config?.enabledForLogin;
    }

    isLoaded(): boolean {
        return !!this.turnstile;
    }

    async load(): Promise<void> {
        if (!this.config || this.turnstile) {
            return;
        }
        if (!this.loadPromise) {
            this.loadPromise = this.loadScript(this.config).finally(() => this.loadPromise = undefined);
        }
        await this.loadPromise;
    }

    private async loadScript(config: CfTurnstileConfig): Promise<void> {
        await new ScriptLoader(this.document).load(config.scriptUrl);
        const turnstile = typeof window !== "undefined" && (window as Window & { turnstile?: TurnstileApi }).turnstile !== undefined ? (window as Window & { turnstile?: TurnstileApi }).turnstile : undefined;
        if (!turnstile) {
            throw new Error("Cloudflare Turnstile API was not found on window scope");
        }
        this.turnstile = turnstile;
    }

    render(element: HTMLElement, action: string, callbacks: CfTurnstileCallbacks): string {
        if (!this.config || !this.turnstile) {
            throw new Error("Cloudflare Turnstile API is not loaded");
        }
        const widgetId = this.turnstile.render(element, {
            sitekey: this.config.siteKey,
            action,
            theme: this.config.theme,
            size: this.config.size,
            callback: callbacks.onToken,
            "expired-callback": callbacks.onTokenExpired,
            "error-callback": callbacks.onError,
        });
        if (!widgetId) {
            throw new Error("Cloudflare Turnstile widget render failed");
        }
        return widgetId;
    }

    reset(widgetId: string): void {
        this.turnstile?.reset(widgetId);
    }

    remove(widgetId: string): void {
        this.turnstile?.remove(widgetId);
    }
}
