import * as THREE from 'three';
import { BatchedMesh } from './BatchedMesh';
const depthMaterial = new THREE.MeshDepthMaterial();
depthMaterial.depthPacking = THREE.RGBADepthPacking;
(depthMaterial as unknown as { clipping: boolean }).clipping = true;
const distanceShader = THREE.ShaderLib.distance;
const distanceUniforms = THREE.UniformsUtils.clone(distanceShader.uniforms);
const distanceMaterial = new THREE.ShaderMaterial({
    defines: { USE_SHADOWMAP: "" },
    uniforms: distanceUniforms,
    vertexShader: distanceShader.vertexShader,
    fragmentShader: distanceShader.fragmentShader,
    clipping: true,
});
export class InstancedMesh extends THREE.InstancedMesh {
    public maxInstances: number;
    public uniformScale: boolean;
    public useInstanceColor: boolean;
    constructor(geometry: THREE.BufferGeometry, material: THREE.Material, maxInstances: number, uniformScale: boolean, useInstanceColor: boolean = false) {
        const instancedGeometry = new THREE.InstancedBufferGeometry();
        (instancedGeometry as unknown as { copy: (source: THREE.BufferGeometry) => void }).copy(geometry);
        super(instancedGeometry, material.clone(), maxInstances);
        this.maxInstances = maxInstances;
        this.uniformScale = uniformScale;
        this.useInstanceColor = useInstanceColor;
        this.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.initAttributes(this.geometry as THREE.InstancedBufferGeometry);
        this.material = this.decorateMaterial(material.clone());
        this.frustumCulled = false;
        this.customDepthMaterial = depthMaterial;
        this.customDistanceMaterial = distanceMaterial;
    }
    private initAttributes(geometry: THREE.InstancedBufferGeometry): void {
        if (this.useInstanceColor) {
            this.instanceColor = new THREE.InstancedBufferAttribute(new Uint8Array(3 * this.maxInstances), 3, true);
            this.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        const opacityAttribute = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances).fill(1), 1);
        opacityAttribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute("instanceOpacity", opacityAttribute);
    }
    private decorateMaterial(material: THREE.Material): THREE.Material {
        if (!material.defines) {
            material.defines = {};
        }
        material.defines.INSTANCE_TRANSFORM = "";
        if (this.useInstanceColor) {
            material.defines.INSTANCE_COLOR = "";
        }
        else {
            delete material.defines.INSTANCE_COLOR;
        }
        material.defines.INSTANCE_OPACITY = "";
        return material;
    }
    public setRenderCount(count: number): void {
        if (count > this.maxInstances) {
            throw new RangeError("Exceeded maximum number of instances");
        }
        this.count = count;
    }
    public setMatrixAt(index: number, matrix: THREE.Matrix4): void {
        super.setMatrixAt(index, matrix);
    }
    public updateFromMeshes(meshes: BatchedMesh[]): void {
        if (meshes.length === 0)
            return;
        const hasPalette = !!((Array.isArray(meshes[0].material) ? meshes[0].material[0] : meshes[0].material) as { palette?: unknown }).palette;
        const attributes = (this.geometry as THREE.InstancedBufferGeometry).attributes;
        const opacityAttr = attributes.instanceOpacity as THREE.InstancedBufferAttribute;
        const paletteOffsetAttr = attributes.instancePaletteOffset as THREE.InstancedBufferAttribute;
        const extraLightAttr = attributes.instanceExtraLight as THREE.InstancedBufferAttribute;
        for (let i = 0, len = meshes.length; i < len; i++) {
            const mesh = meshes[i];
            this.setMatrixAt(i, mesh.matrixWorld);
            const opacity = mesh.getOpacity();
            if (opacityAttr.getX(i) !== opacity) {
                opacityAttr.setX(i, opacity);
                opacityAttr.needsUpdate = true;
            }
            if (hasPalette) {
                const paletteIndex = mesh.getPaletteIndex();
                if (paletteOffsetAttr.getX(i) !== paletteIndex) {
                    paletteOffsetAttr.setX(i, paletteIndex);
                    paletteOffsetAttr.needsUpdate = true;
                }
                const extraLight = mesh.getExtraLight();
                const x = Math.fround(extraLight.x);
                const y = Math.fround(extraLight.y);
                const z = Math.fround(extraLight.z);
                if (x !== extraLightAttr.getX(i) || y !== extraLightAttr.getY(i) || z !== extraLightAttr.getZ(i)) {
                    extraLightAttr.setXYZ(i, x, y, z);
                    extraLightAttr.needsUpdate = true;
                }
            }
        }
        this.setRenderCount(meshes.length);
        this.instanceMatrix.needsUpdate = true;
    }
    public dispose(): this {
        this.geometry.dispose();
        (this.material as THREE.Material).dispose();
        return this;
    }
}
