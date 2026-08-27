import * as THREE from 'three';
import Stats from 'stats.js';
import { EventDispatcher } from '../../util/event';
import { RendererError } from './RendererError';
import { DarkeningComposite } from './DarkeningComposite';
THREE.ColorManagement.enabled = false;
interface SceneLike {
    get3DObject(): THREE.Object3D | undefined;
    create3DObject(): void;
    update(deltaTime: number, ...args: unknown[]): void;
    viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    getScene(): THREE.Scene;
    getCamera(): THREE.Camera;
}
export class Renderer {
    private width: number;
    private height: number;
    private renderer!: THREE.WebGLRenderer;
    private scenes: Set<SceneLike> = new Set();
    private darkeningComposites: Map<SceneLike, DarkeningComposite> = new Map();
    private isContextLost: boolean = false;
    private stats?: Stats;
    private _onFrame = new EventDispatcher<string, number>();
    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }
    get onFrame() {
        return this._onFrame.asEvent();
    }
    getCanvas(): HTMLCanvasElement {
        return this.renderer.domElement;
    }
    getStats(): Stats | undefined {
        return this.stats;
    }
    supportsInstancing(): boolean {
        if (!this.renderer) {
            throw new Error('Renderer not yet initialized');
        }
        return !!this.renderer.extensions.get('ANGLE_instanced_arrays');
    }
    initStats(container: HTMLElement): void {
        if (!this.stats) {
            this.stats = new Stats();
            this.stats.showPanel(0);
            this.stats.dom.style.top = 'auto';
            this.stats.dom.style.bottom = '0px';
            this.stats.dom.classList.add('stats-layer');
            container.appendChild(this.stats.dom);
        }
    }
    destroyStats(): void {
        if (this.stats) {
            if (this.stats.dom.parentNode) {
                this.stats.dom.parentNode.removeChild(this.stats.dom);
            }
            this.stats = undefined;
        }
    }
    init(container: HTMLElement): void {
        const renderer = this.createGlRenderer();
        container.appendChild(renderer.domElement);
        renderer.domElement.addEventListener('contextmenu', (event) => {
            event.preventDefault();
        });
        renderer.domElement.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });
        renderer.domElement.addEventListener('wheel', (event) => {
            event.stopPropagation();
        }, { passive: true });
        renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
        renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);
        this.renderer = renderer;
    }
    createGlRenderer(canvas?: HTMLCanvasElement): THREE.WebGLRenderer {
        let renderer: THREE.WebGLRenderer;
        try {
            renderer = new THREE.WebGLRenderer({
                canvas: canvas,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance',
            });
        }
        catch (error) {
            throw new RendererError('Failed to initialize WebGL renderer');
        }
        renderer.setSize(this.width, this.height);
        renderer.autoClear = false;
        renderer.autoClearDepth = false;
        renderer.shadowMap.enabled = true;
        renderer.localClippingEnabled = true;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        return renderer;
    }
    setSize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        if (this.renderer) {
            this.renderer.setSize(width, height);
        }
    }
    addScene(scene: SceneLike): void {
        this.scenes.add(scene);
        scene.create3DObject();
    }
    removeScene(scene: SceneLike): void {
        this.scenes.delete(scene);
        this.darkeningComposites.get(scene)?.dispose();
        this.darkeningComposites.delete(scene);
    }
    getScenes(): SceneLike[] {
        return [...this.scenes];
    }
    update(deltaTime: number, ...args: unknown[]): void {
        this.scenes.forEach((scene) => {
            scene.update(deltaTime, ...args);
        });
        this._onFrame.dispatch('frame', deltaTime);
    }
    render(): void {
        if (this.isContextLost)
            return;
        this.renderer.clear();
        this.scenes.forEach((scene) => {
            this.renderer.clearDepth();
            const viewportY = this.height - scene.viewport.y - scene.viewport.height;
            const camera = scene.getCamera();
            const darkeningLampCount = (camera.userData as { darkeningLampCount?: number }).darkeningLampCount ?? 0;
            if (darkeningLampCount > 0) {
                let composite = this.darkeningComposites.get(scene);
                if (!composite) {
                    composite = new DarkeningComposite();
                    this.darkeningComposites.set(scene, composite);
                }
                composite.render(this.renderer, scene.getScene(), camera, scene.viewport, viewportY);
                return;
            }
            const existingComposite = this.darkeningComposites.get(scene);
            if (existingComposite) {
                existingComposite.dispose();
                this.darkeningComposites.delete(scene);
            }
            this.renderer.setViewport(scene.viewport.x, viewportY, scene.viewport.width, scene.viewport.height);
            this.renderer.render(scene.getScene(), camera);
        });
    }
    flush(): void {
        this.renderer.renderLists.dispose();
    }
    dispose(): void {
        this.darkeningComposites.forEach((composite) => composite.dispose());
        this.darkeningComposites.clear();
        this.renderer.domElement.remove();
        this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
        this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
        this.renderer.dispose();
        this.destroyStats();
    }
    private handleContextLost = (event: Event): void => {
        event.preventDefault();
        this.isContextLost = true;
    };
    private handleContextRestored = (): void => {
        const canvas = this.renderer.domElement;
        this.renderer.dispose();
        this.renderer = this.createGlRenderer(canvas);
        this.isContextLost = false;
    };
}
