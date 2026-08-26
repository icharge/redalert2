import { ScriptLoader } from "./ScriptLoader";
interface SentryScope {
    setTags(tags: Record<string, string | number | boolean | undefined>): SentryScope;
    setTag(key: string, value: string | number | boolean | undefined): SentryScope;
    setExtra(key: string, value: unknown): SentryScope;
}
interface SentryEvent {
    addAttachment(attachment: { filename: string; data: string }): SentryEvent;
}
type SentryContext = Record<string, unknown> | ((event: SentryEvent) => SentryEvent);
interface SentryInitConfig {
    environment: string;
    release: string;
    denyUrls: RegExp[];
    ignoreErrors: RegExp[];
    initialScope: (scope: SentryScope) => SentryScope;
    defaultIntegrations?: boolean;
}
interface SentryConfig {
    dsn: string;
    env: string;
    defaultIntegrations?: boolean;
    lazyLoad?: boolean;
}
interface SentrySDK {
    init: (config: SentryInitConfig) => void;
    onLoad: (callback: () => void) => void;
    forceLoad: () => void;
    captureException: (error: Error, context?: SentryContext) => void;
    configureScope: (callback: (scope: SentryScope) => void) => void;
    addBreadcrumb: (breadcrumb: unknown) => void;
}
declare global {
    interface Window {
        Sentry: SentrySDK;
    }
}
export class Sentry {
    private sdk?: SentrySDK;
    async init(config: SentryConfig, release: string): Promise<void> {
        await new ScriptLoader(document).load(`https://js.sentry-cdn.com/${config.dsn}.min.js`);
        let sdk = (this.sdk = window.Sentry);
        const initTime = new Date();
        sdk.init({
            environment: config.env,
            release: release,
            denyUrls: [/^file:/],
            ignoreErrors: [
                /init message from worker/,
                /The object can not be found here/,
                /itemsclipboard/,
                /A requested file or directory could not be found/,
                /The requested file could not be read/,
                /The play\(\) request/,
                /^db$/,
            ],
            initialScope: (scope: SentryScope) => scope
                .setTags({ locale: navigator.language })
                .setExtra("initTime", initTime),
            ...(config.defaultIntegrations ? {} : { defaultIntegrations: false }),
        });
        sdk.onLoad(() => {
            this.sdk = window.Sentry;
        });
        if (!config.lazyLoad) {
            sdk.forceLoad();
        }
    }
    captureException(error: Error, context?: SentryContext): void {
        this.sdk?.captureException(error, context);
    }
    configureScope(callback: (scope: SentryScope) => void): void {
        this.sdk?.configureScope(callback);
    }
    addBreadcrumb(breadcrumb: unknown): void {
        this.sdk?.addBreadcrumb(breadcrumb);
    }
}
