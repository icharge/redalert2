import * as THREE from 'three';
import { MeshLine, MeshLineMaterial } from 'three.meshline';
import { Coords } from '@/game/Coords';
import { rampHeights } from '@/game/theater/rampHeights';
import { getMeshLineResolution, getMeshLineWidth } from '@/engine/renderable/fx/MeshLineResolution';

// Matches PlacementGrid/MapTileLayerDebug's own corner order and rampHeights
// indexing, so a corner's drop-line lands under the same point their baked
// ramp-height diamond texture draws it at.
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [0, 0],
    [1, 0],
    [1, 1],
];
const MAX_LINES = CORNER_OFFSETS.length;
// Every drop-line is fed exactly 2 points (its own top/bottom), so MeshLine's
// vCounters run 0->1 across it regardless of the segment's actual world
// length or the current camera zoom - a fixed dashArray therefore always
// draws the same number of dashes per leg. (A length-derived dashArray, the
// way WaypointLine.ts sizes dashes along much longer multi-point paths, was
// tried first here and looked solid rather than dotted at normal editor
// zoom - correct arc-length dash sizing needs many sample points along the
// line to mean anything, which these short 2-point legs don't have.)
const DASH_COUNT = 4;
const DASH_ARRAY = 1 / DASH_COUNT;

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
 * Final Alert-style "this tile is sloped" cue: a short dashed line dropped
 * from each corner of the hovered tile down to that tile's own lowest
 * corner, so a ramp/cliff-edge tile's slope reads at a glance. Deliberately
 * relative to the tile's own base, not the map's absolute height-0 plane -
 * most maps sit at a nonzero baseline elevation throughout, so an absolute
 * reference would draw legs on every single tile instead of just the sloped
 * ones.
 */
export class TileHoverCornerLines {
    private target?: THREE.Object3D;
    private material?: MeshLineMaterial;
    private lineMeshes: THREE.Mesh[] = [];
    private currentTile?: HoverTile;
    constructor(
        private readonly camera: Camera,
        private readonly color: number,
        private readonly lineWidth: number = 1,
    ) { }
    get3DObject(): THREE.Object3D | undefined {
        return this.target;
    }
    create3DObject(): void {
        const object = new THREE.Object3D();
        object.name = 'tile_hover_corner_lines';
        this.target = object;
        this.material = new MeshLineMaterial({
            color: new THREE.Color(this.color),
            lineWidth: getMeshLineWidth(this.camera, this.lineWidth),
            resolution: getMeshLineResolution(this.camera),
            transparent: true,
            sizeAttenuation: 0,
            depthTest: false,
            dashArray: DASH_ARRAY,
            dashRatio: 0.5,
        });
        for (let i = 0; i < MAX_LINES; i++) {
            const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
            mesh.visible = false;
            mesh.renderOrder = 1000000;
            mesh.frustumCulled = false;
            object.add(mesh);
            this.lineMeshes.push(mesh);
        }
    }
    setTile(tile: HoverTile | undefined): void {
        if (tile === this.currentTile) {
            return;
        }
        this.currentTile = tile;
        const segments = tile ? this.computeSegments(tile) : [];
        this.lineMeshes.forEach((mesh, index) => {
            const segment = segments[index];
            if (!segment) {
                mesh.visible = false;
                return;
            }
            const [from, to] = segment;
            const meshLine = new MeshLine();
            meshLine.setPoints([from.x, from.y, from.z, to.x, to.y, to.z]);
            const previousGeometry = mesh.geometry;
            mesh.geometry = meshLine.geometry;
            if (previousGeometry !== mesh.geometry) {
                previousGeometry.dispose();
            }
            mesh.visible = true;
        });
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
    private computeSegments(tile: HoverTile): Array<[THREE.Vector3, THREE.Vector3]> {
        const heights = rampHeights[tile.rampType] ?? rampHeights[0];
        const minHeight = Math.min(...heights);
        const maxHeight = Math.max(...heights);
        if (minHeight === maxHeight) {
            // Flat tile (every corner the same height) - nothing to show.
            // This cue is about slope, not the tile's absolute elevation
            // above the map's own baseline.
            return [];
        }
        const segments: Array<[THREE.Vector3, THREE.Vector3]> = [];
        CORNER_OFFSETS.forEach(([dx, dy], index) => {
            const cornerHeight = heights[index] ?? minHeight;
            if (cornerHeight <= minHeight) {
                return;
            }
            const top = Coords.tile3dToWorld(tile.rx + dx, tile.ry + dy, tile.z + cornerHeight);
            const base = Coords.tile3dToWorld(tile.rx + dx, tile.ry + dy, tile.z + minHeight);
            segments.push([top, base]);
        });
        return segments;
    }
    dispose(): void {
        this.lineMeshes.forEach((mesh) => mesh.geometry.dispose());
        this.material?.dispose();
    }
}
