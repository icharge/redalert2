import { ObjectArt } from '@/game/art/ObjectArt';
import { Coords } from '@/game/Coords';
import * as THREE from 'three';
import { TrailRenderer } from './vendor/TrailRenderer.js';
interface GameSpeed {
    value?: number;
}
interface Container {
    get3DObject(): THREE.Object3D;
    remove(item: LineTrailFx): void;
}
export class LineTrailFx {
    private lazyTarget: () => THREE.Object3D | undefined;
    private trailColor: THREE.Color;
    private trailDecrement: number;
    private gameSpeed: GameSpeed;
    private camera: THREE.Camera;
    private trailInitialized: boolean = false;
    private container?: Container;
    private placeholderObj?: THREE.Object3D;
    private trail?: TrailRenderer;
    private lastTargetMatrix?: THREE.Matrix4;
    private timeLeft?: number;
    private prevUpdateMillis?: number;
    constructor(lazyTarget: () => THREE.Object3D | undefined, trailColor: THREE.Color, trailDecrement: number, gameSpeed: GameSpeed, camera: THREE.Camera) {
        this.lazyTarget = lazyTarget;
        this.trailColor = trailColor;
        this.trailDecrement = trailDecrement;
        this.gameSpeed = gameSpeed;
        this.camera = camera;
    }
    setContainer(container: Container): void {
        this.container = container;
    }
    get3DObject(): THREE.Object3D | undefined {
        return this.placeholderObj;
    }
    create3DObject(): void {
        if (!this.placeholderObj) {
            this.placeholderObj = new THREE.Object3D();
            this.placeholderObj.name = "fx_linetrail_placeholder";
        }
    }
    update(timeMillis: number): void {
        if (this.timeLeft !== undefined) {
            const prevTime = this.prevUpdateMillis;
            this.prevUpdateMillis = timeMillis;
            if (prevTime) {
                this.timeLeft = Math.max(0, this.timeLeft - (timeMillis - prevTime) / 1000);
            }
        }
        if (!this.trailInitialized) {
            this.trailInitialized = true;
            const trail = this.createTrail(this.trailColor, this.trailDecrement);
            if (trail) {
                this.trail = trail;
            }
            else {
                this.timeLeft = 0;
            }
        }
        if (this.trail) {
            this.trail.advance();
            this.lastTargetMatrix = this.trail.targetObject.matrixWorld;
        }
        if (this.isFinished()) {
            this.container?.remove(this);
            this.dispose();
        }
    }
    private createTrail(color: THREE.Color, decrement: number): TrailRenderer | undefined {
        const target = this.lazyTarget();
        if (!target) {
            return undefined;
        }
        const scene = this.container?.get3DObject();
        if (!scene) {
            return undefined;
        }
        const renderer = new TrailRenderer(scene);
        const material = TrailRenderer.createBaseMaterial();
        material.uniforms.headColor.value.set(color.r, color.g, color.b, 1);
        material.uniforms.tailColor.value.set(color.r, color.g, color.b, 0);
        const maxLength = Math.floor(((3 / this.getGameSpeedValue()) * 50) /
            (decrement / ObjectArt.DEFAULT_LINE_TRAIL_DEC));
        const width = 0.8 * Coords.ISO_WORLD_SCALE;
        const plane = new THREE.PlaneGeometry(width, width);
        const quat = new THREE.Quaternion().setFromEuler(this.camera.rotation);
        plane.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quat));
        const positionAttr = plane.getAttribute('position');
        const headVertices: THREE.Vector3[] = [];
        for (let i = 0; i < positionAttr.count; i++) {
            headVertices.push(new THREE.Vector3(
                positionAttr.getX(i),
                positionAttr.getY(i),
                positionAttr.getZ(i),
            ));
        }
        renderer.initialize(material, maxLength, false, 0, headVertices, target);
        renderer.activate();
        return renderer;
    }
    isFinished(): boolean {
        return this.timeLeft === 0;
    }
    requestFinishAndDispose(): void {
        this.timeLeft = 0.8 / this.getGameSpeedValue();
    }
    stopTracking(): void {
        if (this.trail && this.lastTargetMatrix) {
            const obj = new THREE.Object3D();
            obj.updateMatrixWorld = () => { };
            obj.matrixWorld = this.lastTargetMatrix;
            this.trail.targetObject = obj;
        }
    }
    dispose(): void {
        this.trail?.deactivate();
        this.trail?.material.dispose();
        this.trail?.geometry.dispose();
    }
    private getGameSpeedValue(): number {
        if (typeof this.gameSpeed?.value !== 'number') {
            throw new Error(`[LineTrailFx] invalid gameSpeed dependency. Expected BoxedVar<number>, got "${this.gameSpeed?.constructor?.name ?? typeof this.gameSpeed}"`);
        }
        return this.gameSpeed.value;
    }
}
