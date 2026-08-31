import * as THREE from 'three';
import { MeshLine, MeshLineMaterial } from 'three.meshline';
import { Coords } from '@/game/Coords';
import { rampHeights } from '@/game/theater/rampHeights';
import { getMeshLineResolution, getMeshLineWidth } from '@/engine/renderable/fx/MeshLineResolution';

// Same corner order as PlacementGrid.getTileOverlayTexture()/
// TileHoverCornerLines - tracing these 4 corners consecutively (looping back
// to the first) draws a closed diamond outline in world space.
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [0, 0],
    [1, 0],
    [1, 1],
];

interface Camera extends THREE.Camera {
    top: number;
    right: number;
    rotation: THREE.Euler;
    userData: THREE.Object3D['userData'];
}
interface HoverTile {
    rx: number;
    ry: number;
    z: number;
    rampType: number;
}

/**
 * Ramp-height-aware outline of the hovered tile's top face - a solid, bold,
 * constant-pixel-width line loop with no fill, so nothing under the cursor
 * (in particular a Paint Terrain Mode brush preview - see
 * MapEditorTester.updatePaintPreview()) gets tinted or obscured the way
 * PlacementGrid's semi-opaque colored fill would. Deliberately a standalone
 * class rather than reusing PlacementGrid: PlacementGrid's diamond shape is
 * baked into one shared texture also used by real building placement, and
 * this needs a different render style (outline, not fill) without touching
 * that shared, gameplay-facing asset. Corner heights follow rampType the
 * same way TileHoverCornerLines' drop-lines do, so the outline correctly
 * hugs a sloped/cliff-edge tile instead of floating flat over it.
 */
export class TileHoverOutline {
    private target?: THREE.Object3D;
    private material?: MeshLineMaterial;
    private mesh?: THREE.Mesh;
    private currentTile?: HoverTile;
    constructor(
        private readonly camera: Camera,
        private readonly color: number,
        private readonly lineWidth: number = 3,
    ) { }
    get3DObject(): THREE.Object3D | undefined {
        return this.target;
    }
    create3DObject(): void {
        const object = new THREE.Object3D();
        object.name = 'tile_hover_outline';
        this.target = object;
        this.material = new MeshLineMaterial({
            color: new THREE.Color(this.color),
            lineWidth: getMeshLineWidth(this.camera, this.lineWidth),
            resolution: getMeshLineResolution(this.camera),
            transparent: true,
            sizeAttenuation: 0,
            depthTest: false,
        });
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
        mesh.visible = false;
        mesh.renderOrder = 1000000;
        mesh.frustumCulled = false;
        object.add(mesh);
        this.mesh = mesh;
    }
    setTile(tile: HoverTile | undefined): void {
        if (tile === this.currentTile) {
            return;
        }
        this.currentTile = tile;
        if (!this.mesh) {
            return;
        }
        if (!tile) {
            this.mesh.visible = false;
            return;
        }
        const heights = rampHeights[tile.rampType] ?? rampHeights[0];
        const points: number[] = [];
        // CORNER_OFFSETS.length + 1 iterations: the extra one repeats the
        // first corner, closing the loop into a full diamond outline rather
        // than 3 sides of one.
        for (let i = 0; i <= CORNER_OFFSETS.length; i++) {
            const index = i % CORNER_OFFSETS.length;
            const [dx, dy] = CORNER_OFFSETS[index];
            const cornerHeight = heights[index] ?? 0;
            const world = Coords.tile3dToWorld(tile.rx + dx, tile.ry + dy, tile.z + cornerHeight);
            points.push(world.x, world.y, world.z);
        }
        const meshLine = new MeshLine();
        meshLine.setPoints(points);
        const previousGeometry = this.mesh.geometry;
        this.mesh.geometry = meshLine.geometry;
        if (previousGeometry !== this.mesh.geometry) {
            previousGeometry.dispose();
        }
        this.mesh.visible = true;
    }
    // Resolution/width can change on window resize; cheap to refresh every
    // frame since this only touches two shared-material uniforms, not
    // per-line geometry.
    update(): void {
        if (!this.material) {
            return;
        }
        this.material.uniforms.resolution.value.copy(getMeshLineResolution(this.camera));
        this.material.uniforms.lineWidth.value = getMeshLineWidth(this.camera, this.lineWidth);
    }
    dispose(): void {
        this.mesh?.geometry.dispose();
        this.material?.dispose();
    }
}
