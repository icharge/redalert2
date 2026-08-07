import { CastProgressTrait } from "@/game/gameobject/trait/CastProgressTrait";
import { SpriteUtils } from "@/engine/gfx/SpriteUtils";
import { Coords } from "@/game/Coords";
import { clamp } from "@/util/math";
import * as THREE from "three";

export class UnitCastBarSprite {
    private ctx: CanvasRenderingContext2D | null = null;
    private texture: THREE.Texture | null = null;
    private mesh: THREE.Mesh | null = null;
    private lastBarWidth: number | undefined;
    private barWidth: number;
    private screenOffsetX: number;
    private screenOffsetY: number;
    private worldOffsetY: number;

    constructor(
        private castProgressTrait: CastProgressTrait,
        private camera: THREE.Camera,
        barWidth: number,
        screenOffsetX: number,
        screenOffsetY: number,
        worldOffsetY: number,
    ) {
        this.barWidth = barWidth;
        this.screenOffsetX = screenOffsetX;
        this.screenOffsetY = screenOffsetY;
        this.worldOffsetY = worldOffsetY;
    }

    get3DObject(): THREE.Object3D | null {
        return this.mesh;
    }

    create3DObject(): void {
        if (!this.mesh) {
            const canvas = document.createElement("canvas");
            canvas.width = this.barWidth + 2;
            canvas.height = 4;
            this.ctx = canvas.getContext("2d", { alpha: true });

            const texture = this.texture = new THREE.Texture(canvas);
            texture.minFilter = THREE.NearestFilter;
            texture.magFilter = THREE.NearestFilter;
            texture.flipY = true;

            const geometry = SpriteUtils.createSpriteGeometry({
                texture,
                camera: this.camera as any,
                align: { x: 0, y: -1 },
                scale: Coords.ISO_WORLD_SCALE,
            });
            const material = new THREE.MeshBasicMaterial({
                map: texture,
                side: THREE.DoubleSide,
                transparent: true,
                depthTest: false,
            });
            const mesh = this.mesh = new THREE.Mesh(geometry, material);
            mesh.matrixAutoUpdate = false;
            mesh.renderOrder = 999998;

            const screenPos = Coords.screenDistanceToWorld(this.screenOffsetX, this.screenOffsetY);
            mesh.position.x = screenPos.x;
            mesh.position.y = this.worldOffsetY;
            mesh.position.z = screenPos.y;
            mesh.updateMatrix();
            mesh.visible = false;
        }
    }

    update(_deltaTime: number): void {
        if (!this.mesh || !this.ctx || !this.texture) {
            return;
        }
        const trait = this.castProgressTrait;
        const fillWidth = trait.isCasting() ? this.getFillWidth(trait.getProgress()) : undefined;
        if (this.lastBarWidth !== fillWidth) {
            this.lastBarWidth = fillWidth;
            if (fillWidth !== undefined) {
                this.redraw(fillWidth);
                this.texture.needsUpdate = true;
            }
            this.mesh.visible = fillWidth !== undefined;
        }
    }

    private redraw(fillWidth: number): void {
        if (!this.ctx) {
            return;
        }
        this.ctx.clearRect(0, 0, this.barWidth + 2, 4);
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
        this.ctx.fillRect(0, 0, this.barWidth + 2, 4);
        if (fillWidth > 0) {
            this.ctx.fillStyle = "cyan";
            this.ctx.fillRect(1, 1, fillWidth, 2);
        }
    }

    private getFillWidth(progress: number): number {
        return clamp(Math.ceil(this.barWidth * progress), 1, this.barWidth);
    }

    dispose(): void {
        this.texture?.dispose();
        (this.mesh?.material as THREE.Material | undefined)?.dispose();
        this.mesh?.geometry.dispose();
    }
}
