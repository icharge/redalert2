export interface ViewportRect {
    x: number;
    y: number;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    scale?: number;
    isMobileLayout?: boolean;
    isPortrait?: boolean;
}
export interface Viewport {
    value: ViewportRect;
    rootElement?: HTMLElement;
    onChange?: {
        subscribe(listener: (value: ViewportRect) => void): void;
        unsubscribe(listener: (value: ViewportRect) => void): void;
    };
}
