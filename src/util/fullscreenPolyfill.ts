interface FullscreenApiDef {
    enabled: string;
    element: string;
    request: string;
    exit: string;
    events: {
        change: string;
        error: string;
    };
}
const apiDefs: FullscreenApiDef[] = [
    {
        enabled: "fullscreenEnabled",
        element: "fullscreenElement",
        request: "requestFullscreen",
        exit: "exitFullscreen",
        events: { change: "fullscreenchange", error: "fullscreenerror" },
    },
    {
        enabled: "webkitFullscreenEnabled",
        element: "webkitCurrentFullScreenElement",
        request: "webkitRequestFullscreen",
        exit: "webkitExitFullscreen",
        events: { change: "webkitfullscreenchange", error: "webkitfullscreenerror" },
    },
    {
        enabled: "mozFullScreenEnabled",
        element: "mozFullScreenElement",
        request: "mozRequestFullScreen",
        exit: "mozCancelFullScreen",
        events: { change: "mozfullscreenchange", error: "mozfullscreenerror" },
    },
    {
        enabled: "msFullscreenEnabled",
        element: "msFullscreenElement",
        request: "msRequestFullscreen",
        exit: "msExitFullscreen",
        events: { change: "MSFullscreenChange", error: "MSFullscreenError" },
    },
];
type DocumentLike = Document & {
    [key: string]: unknown;
};
/**
 * Normalizes a vendor-prefixed Fullscreen API onto the W3C names
 * (`fullscreenEnabled`/`fullscreenElement`/`requestFullscreen`/`exitFullscreen`
 * and the `fullscreenchange`/`fullscreenerror` events), wrapping exit/request
 * to return Promises on legacy browsers. Mirrors upstream
 * `lib/fullscreen-api-polyfill.min.js`.
 */
export function polyfillFullscreen(doc: DocumentLike): void {
    let foundApi: FullscreenApiDef | undefined;
    for (const def of apiDefs) {
        if (def.enabled in doc) {
            foundApi = def;
            break;
        }
    }
    const w3 = apiDefs[0];
    if (w3.enabled in doc || !foundApi) {
        return;
    }
    const normalizeChange = (event: Event): void => {
        event.stopPropagation();
        event.stopImmediatePropagation();
        doc[w3.enabled] = doc[foundApi!.enabled];
        doc[w3.element] = doc[foundApi!.element];
        doc.dispatchEvent(new Event(w3.events.change, { bubbles: true }));
    };
    const normalizeError = (event: Event): void => {
        doc.dispatchEvent(new Event(w3.events.error, { bubbles: true }));
    };
    const wrapWithPromise = (call: () => void, isExit: boolean): Promise<void> => {
        return new Promise((resolve, reject) => {
            const onChange = (): void => {
                resolve();
                doc.removeEventListener(foundApi!.events.change, onChange, false);
            };
            const onError = (): void => {
                reject(new TypeError());
                doc.removeEventListener(foundApi!.events.error, onError, false);
            };
            if (isExit && !doc[foundApi!.element]) {
                setTimeout(() => reject(new TypeError()), 1);
                return;
            }
            doc.addEventListener(foundApi!.events.change, onChange, false);
            doc.addEventListener(foundApi!.events.error, onError, false);
        });
    };
    doc.addEventListener(foundApi.events.change, normalizeChange, false);
    doc.addEventListener(foundApi.events.error, normalizeError, false);
    doc[w3.enabled] = doc[foundApi.enabled];
    doc[w3.element] = doc[foundApi.element];
    doc[w3.exit] = function (): void | Promise<void> {
        const result = (doc[foundApi!.exit] as () => Promise<void> | undefined)();
        return !result && typeof Promise !== "undefined"
            ? wrapWithPromise(() => result, true)
            : result;
    };
    (Element.prototype as Element & Record<string, unknown>)[w3.request] = function (): void | Promise<void> {
        const result = this[foundApi!.request].apply(this, arguments);
        return !result && typeof Promise !== "undefined"
            ? wrapWithPromise(() => result, false)
            : result;
    };
}
