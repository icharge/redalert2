import * as THREE from 'three';
import { DARKENING_LAMP_LAYER } from './RenderLayers';

// Real RA2 accumulates every overlapping negative-light source's contribution
// additively into a single per-tile ambient multiplier, then clamps that ONE
// combined total before applying it to the base color once (see
// CNCMaps.Engine.Rendering.Palette.ApplyLamp/Recalculate). Rendering each
// darkening lamp as a separate multiplicative blend pass over the already-
// drawn scene (the previous approach here) compounds instead of summing, and
// 8-bit blending rounds the compounded result to literal black once enough
// lamps overlap. This class reproduces the authentic accumulate-once-clamp-
// once behavior: darkening lamps (put on DARKENING_LAMP_LAYER by Building.ts)
// render additively into an offscreen "darkness" buffer separate from the
// normal scene, and a final composite pass multiplies the base scene by
// (1 - min(darkness, maxDarkness)), guaranteeing a brightness floor no matter
// how many lamps overlap.
const MAX_DARKNESS = 0.6;
const COMPOSITE_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;
const COMPOSITE_FRAGMENT_SHADER = `
    uniform sampler2D baseTex;
    uniform sampler2D darkTex;
    uniform float maxDarkness;
    varying vec2 vUv;
    void main() {
        vec3 base = texture2D(baseTex, vUv).rgb;
        vec3 darkness = min(texture2D(darkTex, vUv).rgb, vec3(maxDarkness));
        gl_FragColor = vec4(base * (1.0 - darkness), 1.0);
    }
`;
export class DarkeningComposite {
    private baseTarget?: THREE.WebGLRenderTarget;
    private darkTarget?: THREE.WebGLRenderTarget;
    private quadScene: THREE.Scene;
    private quadCamera: THREE.OrthographicCamera;
    private quadMaterial: THREE.ShaderMaterial;
    private width = 0;
    private height = 0;
    constructor() {
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quadMaterial = new THREE.ShaderMaterial({
            uniforms: {
                baseTex: { value: null },
                darkTex: { value: null },
                maxDarkness: { value: MAX_DARKNESS },
            },
            vertexShader: COMPOSITE_VERTEX_SHADER,
            fragmentShader: COMPOSITE_FRAGMENT_SHADER,
            depthTest: false,
            depthWrite: false,
        });
        this.quadScene = new THREE.Scene();
        this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMaterial));
    }
    private ensureTargets(width: number, height: number): void {
        if (this.width === width && this.height === height && this.baseTarget && this.darkTarget) {
            return;
        }
        this.width = width;
        this.height = height;
        this.baseTarget?.dispose();
        this.darkTarget?.dispose();
        const targetOptions = {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            depthBuffer: true,
        };
        this.baseTarget = new THREE.WebGLRenderTarget(width, height, targetOptions);
        this.darkTarget = new THREE.WebGLRenderTarget(width, height, { ...targetOptions, depthBuffer: false });
    }
    render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
    }, viewportY: number): void {
        this.ensureTargets(viewport.width, viewport.height);
        const baseTarget = this.baseTarget!;
        const darkTarget = this.darkTarget!;
        const cameraLayers = (camera as THREE.Object3D).layers;
        const priorMask = cameraLayers.mask;
        renderer.setRenderTarget(baseTarget);
        renderer.setViewport(0, 0, viewport.width, viewport.height);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, true, false);
        cameraLayers.disable(DARKENING_LAMP_LAYER);
        renderer.render(scene, camera);
        renderer.setRenderTarget(darkTarget);
        renderer.setViewport(0, 0, viewport.width, viewport.height);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);
        cameraLayers.mask = 0;
        cameraLayers.enable(DARKENING_LAMP_LAYER);
        renderer.render(scene, camera);
        cameraLayers.mask = priorMask;
        this.quadMaterial.uniforms.baseTex.value = baseTarget.texture;
        this.quadMaterial.uniforms.darkTex.value = darkTarget.texture;
        renderer.setRenderTarget(null);
        renderer.setViewport(viewport.x, viewportY, viewport.width, viewport.height);
        renderer.render(this.quadScene, this.quadCamera);
    }
    dispose(): void {
        this.baseTarget?.dispose();
        this.darkTarget?.dispose();
        this.quadMaterial.dispose();
        this.quadScene.children.forEach((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
            }
        });
    }
}
