import { Coords } from '@/game/Coords';
import * as THREE from 'three';
import { LightningStrike } from './vendor/LightningStrike.js';
export class TeslaFx {
    private sourcePos: THREE.Vector3;
    private targetPos: THREE.Vector3;
    private primaryColor: THREE.Color;
    private secondaryColor: THREE.Color;
    private durationSeconds: number;
    private bolts: LightningStrike[];
    private boltMeshes: THREE.Mesh[];
    private container?: {
        remove(item: unknown): void;
    };
    private target?: THREE.Object3D;
    private firstUpdateMillis?: number;
    private timeLeft: number = 1;
    constructor(sourcePos: THREE.Vector3, targetPos: THREE.Vector3, primaryColor: THREE.Color, secondaryColor: THREE.Color, durationSeconds: number) {
        this.sourcePos = sourcePos;
        this.targetPos = targetPos;
        this.primaryColor = primaryColor;
        this.secondaryColor = secondaryColor;
        this.durationSeconds = durationSeconds;
        this.bolts = [];
        this.boltMeshes = [];
    }
    setContainer(container: {
        remove(item: unknown): void;
    }): void {
        this.container = container;
    }
    get3DObject(): THREE.Object3D | undefined {
        return this.target;
    }
    create3DObject(): void {
        if (!this.target) {
            this.target = new THREE.Object3D();
            this.target.name = "fx_tesla";
            const primaryHex = this.primaryColor.getHex();
            const colors = [primaryHex, primaryHex, this.secondaryColor.getHex()];
            colors.forEach((color) => {
                try {
                    const { mesh, bolt } = this.createBolt(color);
                    this.boltMeshes.push(mesh);
                    this.bolts.push(bolt);
                    this.target?.add(mesh);
                }
                catch (e) {
                    console.warn("Couldn't create lightning FX", [e]);
                }
            });
        }
    }
    update(timeMillis: number): void {
        if (!this.firstUpdateMillis) {
            this.firstUpdateMillis = timeMillis;
        }
        const elapsedSeconds = (timeMillis - this.firstUpdateMillis) / 1000;
        this.timeLeft = Math.max(0, 1 - elapsedSeconds / this.durationSeconds);
        try {
            this.bolts.forEach(bolt => bolt.update(elapsedSeconds));
        }
        catch (e) {
            console.warn("Couldn't update lightning FX", [e]);
        }
        if (this.isFinished()) {
            this.container?.remove(this);
            this.dispose();
        }
    }
    private createBolt(color: number): {
        mesh: THREE.Mesh;
        bolt: LightningStrike;
    } {
        const sourceOffset = this.sourcePos.clone();
        const destOffset = this.targetPos.clone();
        const strike = new LightningStrike({
            sourceOffset,
            destOffset,
            radius0: 0.3 * Coords.ISO_WORLD_SCALE,
            radius1: 0.3 * Coords.ISO_WORLD_SCALE,
            isEternal: true,
            timeScale: 2,
            propagationTimeFactor: 0.05,
            vanishingTimeFactor: 0.95,
            ramification: 0,
            roughness: 0.85,
            straightness: 0.7,
        });
        const material = new THREE.MeshBasicMaterial({ color });
        return { mesh: new THREE.Mesh(strike, material), bolt: strike };
    }
    isFinished(): boolean {
        return this.timeLeft === 0;
    }
    dispose(): void {
        this.boltMeshes.forEach((mesh) => {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
        });
    }
}
