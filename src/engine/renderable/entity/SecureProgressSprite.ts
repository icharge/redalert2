import { SecureProgressTrait } from "@/game/gameobject/trait/SecureProgressTrait";
import { CanvasUtils } from "@/engine/gfx/CanvasUtils";
import { SpriteUtils } from "@/engine/gfx/SpriteUtils";
import { Coords } from "@/game/Coords";
import { clamp } from "@/util/math";
import * as THREE from "three";

export class SecureProgressSprite {
    private ctx: CanvasRenderingContext2D | null = null;
    private texture: THREE.Texture | null = null;
    private mesh: THREE.Mesh | null = null;
    private lastKey: string | undefined;

    constructor(
        private building: any,
        private camera: THREE.Camera,
        private viewer: any,
        private alliances: any,
        private selectionModel: any,
    ) {
    }

    get3DObject(): THREE.Object3D | null {
        return this.mesh;
    }

    create3DObject(): void {
        if (!this.mesh) {
            const canvas = document.createElement("canvas");
            canvas.width = 90;
            canvas.height = 26;
            this.ctx = canvas.getContext("2d", { alpha: true });

            const texture = this.texture = new THREE.Texture(canvas);
            texture.minFilter = THREE.NearestFilter;
            texture.magFilter = THREE.NearestFilter;
            texture.flipY = true;

            const geometry = SpriteUtils.createSpriteGeometry({
                texture,
                camera: this.camera as any,
                align: { x: 1, y: -1 },
                offset: { x: -Math.floor(45), y: -Math.floor(13) },
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
            mesh.visible = false;
            mesh.position.x = Coords.getWorldTileSize() * this.building.art.foundation.width / 2;
            mesh.position.y = Coords.tileHeightToWorld((this.building.art.height + 1) / 2);
            mesh.position.z = Coords.getWorldTileSize() * this.building.art.foundation.height / 2;
            mesh.updateMatrix();
        }
    }

    update(_deltaTime: number): void {
        if (!this.mesh || !this.ctx || !this.texture) {
            return;
        }
        const key = this.computeKey();
        if (!key) {
            this.lastKey = undefined;
            this.mesh.visible = false;
            return;
        }
        if (this.lastKey !== key) {
            this.lastKey = key;
            this.redraw();
            this.texture.needsUpdate = true;
        }
        const viewer = this.viewer.value;
        const securingPlayer = this.building.secureProgressTrait?.getSecuringPlayer();
        this.mesh.renderOrder = (viewer && securingPlayer && this.alliances.haveSharedIntel(viewer, securingPlayer)) ? 999999 : 999998;
        this.mesh.visible = true;
    }

    private computeKey(): string | undefined {
        const trait: SecureProgressTrait | undefined = this.building.secureProgressTrait;
        const securingPlayer = trait?.getSecuringPlayer();
        if (trait?.isActive() && securingPlayer) {
            const isHovered = this.selectionModel.isHovered();
            return [securingPlayer.name, securingPlayer.color.asHex(), this.getFillWidth(trait.getProgress()), isHovered ? 1 : 0].join("_");
        }
        return undefined;
    }

    private redraw(): void {
        const ctx = this.ctx;
        const trait: SecureProgressTrait | undefined = this.building.secureProgressTrait;
        const securingPlayer = trait?.getSecuringPlayer();
        if (!ctx || !trait?.isActive() || !securingPlayer) {
            return;
        }
        const color = securingPlayer.color.asHexString();
        const fillWidth = this.getFillWidth(trait.getProgress());
        const isHovered = this.selectionModel.isHovered();
        ctx.clearRect(0, 0, 90, 26);
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        if (isHovered) {
            ctx.fillRect(0, 0, 90, 26);
            CanvasUtils.drawText(ctx, securingPlayer.name, 0, 0, {
                color,
                fontFamily: "'Fira Sans Condensed', Arial, sans-serif",
                fontSize: 10,
                fontWeight: "500",
                textAlign: "center",
                width: 90,
                paddingTop: 4,
            });
        }
        else {
            ctx.fillRect(4, 15, 82, 9);
        }
        ctx.fillStyle = "rgba(15, 15, 15, 0.95)";
        ctx.fillRect(6, 17, 78, 5);
        ctx.fillStyle = color;
        ctx.fillRect(5, 16, 80, 1);
        ctx.fillRect(5, 22, 80, 1);
        ctx.fillRect(5, 17, 1, 5);
        ctx.fillRect(84, 17, 1, 5);
        if (fillWidth > 0) {
            ctx.fillRect(7, 18, fillWidth, 3);
        }
    }

    private getFillWidth(progress: number): number {
        return clamp(Math.ceil(76 * progress), 1, 76);
    }

    dispose(): void {
        this.texture?.dispose();
        (this.mesh?.material as THREE.Material | undefined)?.dispose();
        this.mesh?.geometry.dispose();
    }
}
