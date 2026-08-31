import { CompositeDisposable } from '../util/disposable/CompositeDisposable';
export class CanvasMetrics {
    public x: number;
    public y: number;
    public width: number;
    public height: number;
    public displayWidth: number;
    public displayHeight: number;
    private canvas: HTMLCanvasElement;
    private window: Window;
    private disposables: CompositeDisposable;
    private updateCanvasBoxMetrics: () => void;
    constructor(canvas: HTMLCanvasElement, window: Window) {
        this.canvas = canvas;
        this.window = window;
        this.x = 0;
        this.y = 0;
        this.width = 0;
        this.height = 0;
        this.displayWidth = 0;
        this.displayHeight = 0;
        this.disposables = new CompositeDisposable();
        this.updateCanvasBoxMetrics = () => {
            const rect = this.canvas.getBoundingClientRect();
            this.x = rect.left + this.window.scrollX;
            this.y = rect.top + this.window.scrollY;
            // width/height feed scaleDisplayPosition() below and the pointer-
            // clamp bounds in Pointer.ts/PointerEvents.ts - both need to land
            // in the same CSS-pixel space every other screen-space consumer
            // uses (WorldScene/UiScene camera frustums are sized directly
            // from the CSS-pixel viewport, see getCameraParams/createCamera),
            // not canvas.width/height (the internal drawing-buffer
            // resolution). Those two were numerically identical as long as
            // nothing ever called setPixelRatio() - true everywhere in this
            // codebase until it was finally wired up, at which point canvas
            // .width became devicePixelRatio times bigger than the CSS box,
            // and every click/hover started resolving to the wrong world
            // position (worse the higher the DPR) because pointer math was
            // silently scaling into buffer-pixel space while everything it
            // gets compared against stayed in CSS-pixel space.
            this.displayWidth = rect.width || this.canvas.clientWidth || this.canvas.width;
            this.displayHeight = rect.height || this.canvas.clientHeight || this.canvas.height;
            this.width = this.displayWidth;
            this.height = this.displayHeight;
        };
    }
    init(): void {
        this.updateCanvasBoxMetrics();
        this.window.addEventListener('resize', this.updateCanvasBoxMetrics);
        this.window.visualViewport?.addEventListener('resize', this.updateCanvasBoxMetrics);
        this.disposables.add(() => this.window.removeEventListener('resize', this.updateCanvasBoxMetrics));
        this.disposables.add(() => this.window.visualViewport?.removeEventListener('resize', this.updateCanvasBoxMetrics));
    }
    notifyViewportChange(): void {
        this.updateCanvasBoxMetrics();
    }
    toCanvasPosition(pageX: number, pageY: number): { x: number; y: number; } {
        return this.scaleDisplayPosition({
            x: pageX - this.x,
            y: pageY - this.y,
        });
    }
    toCanvasOffset(offsetX: number, offsetY: number): { x: number; y: number; } {
        return this.scaleDisplayPosition({ x: offsetX, y: offsetY });
    }
    private scaleDisplayPosition(position: { x: number; y: number; }): { x: number; y: number; } {
        const scaleX = this.displayWidth > 0 ? this.width / this.displayWidth : 1;
        const scaleY = this.displayHeight > 0 ? this.height / this.displayHeight : 1;
        return {
            x: position.x * scaleX,
            y: position.y * scaleY,
        };
    }
    dispose(): void {
        this.disposables.dispose();
    }
}
