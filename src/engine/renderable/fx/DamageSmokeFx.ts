import { AnimProps } from '@/engine/AnimProps';
import { ImageUtils } from '@/engine/gfx/ImageUtils';
import type { ShpFile } from '@/data/ShpFile';
import type { Palette } from '@/data/Palette';
import type { IniSection } from '@/data/IniSection';
import * as THREE from 'three';
import SPE from './speRuntime';
import { patchSpeGroup } from './speCompat';
interface SmokeArt {
    art: {
        getBool(key: string): boolean;
    };
}
interface GameObject {
    position: {
        worldPosition: THREE.Vector3;
    };
    rules: {
        damageSmokeOffset: THREE.Vector3;
    };
}
interface GameSpeed {
    value: number;
}
interface Container {
    remove(item: unknown): void;
}
declare namespace SPETypes {
    interface GroupConfig {
        texture: {
            value: THREE.Texture;
            frames: THREE.Vector2;
            frameCount: number;
            loop: number;
        };
        maxParticleCount: number;
        hasPerspective: boolean;
        transparent: boolean;
        alphaTest: number;
        blending: THREE.Blending;
    }
    interface EmitterConfig {
        particleCount: number;
        maxAge: {
            value: number;
        };
        activeMultiplier: number;
        position: {
            value: THREE.Vector3;
        };
        acceleration: {
            value: THREE.Vector3;
            spread: THREE.Vector3;
        };
        velocity: {
            value: THREE.Vector3;
            spread: THREE.Vector3;
        };
        opacity: {
            value: number | number[];
        };
        size: {
            value: number;
        };
    }
    class Group {
        mesh: THREE.Mesh;
        constructor(config: GroupConfig);
        addEmitter(emitter: Emitter): void;
        tick(deltaTime: number): void;
    }
    class Emitter {
        position: {
            value: THREE.Vector3;
        };
        alive: boolean;
        constructor(config: EmitterConfig);
        disable(): void;
        enable(): void;
    }
}
const PARTICLE_COUNT = 1000;
export class DamageSmokeFx {
    private static textureCache = new Map<ShpFile, THREE.Texture>();
    private gameObject: GameObject;
    private smokeArt: SmokeArt;
    private shpFile: ShpFile;
    private palette: Palette;
    private gameSpeed: GameSpeed;
    private lifetimeSeconds: number;
    private finishRequested: boolean;
    private container?: Container;
    private particleGroup?: SPETypes.Group;
    private particleEmitter?: SPETypes.Emitter;
    private particleMaxAge?: number;
    private lastUpdateMillis?: number;
    private firstUpdateMillis?: number;
    private timeLeft?: number;
    static clearTextureCache() {
        this.textureCache.forEach(texture => texture.dispose());
        this.textureCache.clear();
    }
    constructor(gameObject: GameObject, smokeArt: SmokeArt, shpFile: ShpFile, palette: Palette, gameSpeed: GameSpeed) {
        this.gameObject = gameObject;
        this.smokeArt = smokeArt;
        this.shpFile = shpFile;
        this.palette = palette;
        this.gameSpeed = gameSpeed;
        this.lifetimeSeconds = Number.POSITIVE_INFINITY;
        this.finishRequested = false;
    }
    setContainer(container: Container) {
        this.container = container;
    }
    create3DObject() {
        if (!this.particleGroup) {
            let texture = DamageSmokeFx.textureCache.get(this.shpFile);
            if (!texture) {
                const canvas = ImageUtils.convertShpToCanvas(this.shpFile, this.palette, true);
                texture = new THREE.Texture(canvas);
                texture.minFilter = THREE.NearestFilter;
                texture.magFilter = THREE.NearestFilter;
                texture.needsUpdate = true;
                texture.flipY = false;
                DamageSmokeFx.textureCache.set(this.shpFile, texture);
            }
            this.particleGroup = new SPE.Group({
                texture: {
                    value: texture,
                    frames: new THREE.Vector2(this.shpFile.numImages, 1),
                    frameCount: this.shpFile.numImages,
                    loop: 1
                },
                maxParticleCount: PARTICLE_COUNT,
                hasPerspective: false,
                transparent: true,
                alphaTest: 0,
                blending: THREE.NormalBlending
            });
            patchSpeGroup(this.particleGroup);
            this.particleGroup.mesh.name = "fx_damage_smoke";
            this.particleGroup.mesh.frustumCulled = false;
            const animProps = new AnimProps(this.smokeArt.art as unknown as IniSection, this.shpFile);
            const rate = (this.smokeArt.art.getBool("Normalized") ? 2 : 1) * animProps.rate;
            const activeMultiplier = rate / 10;
            this.particleMaxAge = (2 * this.shpFile.numImages) / animProps.rate;
            const velocity = 9 * rate;
            const acceleration = 0.05 * rate;
            this.particleEmitter = new SPE.Emitter({
                particleCount: PARTICLE_COUNT,
                maxAge: { value: this.particleMaxAge },
                activeMultiplier: activeMultiplier / (PARTICLE_COUNT / this.particleMaxAge),
                position: { value: this.computeEmitterPosition() },
                acceleration: {
                    value: new THREE.Vector3(0, -acceleration, 0),
                    spread: new THREE.Vector3(2, 0, 2)
                },
                velocity: {
                    value: new THREE.Vector3(0, velocity, 0),
                    spread: new THREE.Vector3(0.1 * velocity, 0, 0.1 * velocity)
                },
                opacity: { value: 0.5 },
                size: {
                    value: Math.max(this.shpFile.height, this.shpFile.width)
                }
            });
            this.particleGroup.addEmitter(this.particleEmitter);
        }
    }
    computeEmitterPosition() {
        return this.gameObject.position.worldPosition
            .clone()
            .add(this.gameObject.rules.damageSmokeOffset);
    }
    get3DObject() {
        return this.particleGroup?.mesh;
    }
    update(timeMillis: number) {
        if (this.particleEmitter) {
            this.particleEmitter.position.value = this.computeEmitterPosition();
        }
        if (this.lastUpdateMillis) {
            const deltaTime = timeMillis - this.lastUpdateMillis;
            this.particleGroup?.tick((deltaTime / 1000) * this.gameSpeed.value);
        }
        else {
            this.firstUpdateMillis = timeMillis;
            this.particleGroup?.tick(0);
        }
        this.lastUpdateMillis = timeMillis;
        if (this.finishRequested) {
            this.finishRequested = false;
            if (this.particleEmitter?.alive) {
                const elapsedTime = ((timeMillis - (this.firstUpdateMillis || 0)) / 1000) * this.gameSpeed.value;
                this.lifetimeSeconds = elapsedTime + (this.particleMaxAge || 0);
                this.particleEmitter.disable();
            }
        }
        this.timeLeft = Math.max(0, 1 - (timeMillis - (this.firstUpdateMillis || 0)) / ((1000 * this.lifetimeSeconds) / this.gameSpeed.value));
        if (!this.timeLeft) {
            this.container?.remove(this);
            this.dispose();
        }
    }
    finishAndRemove() {
        this.finishRequested = true;
    }
    dispose() {
        this.particleGroup?.mesh.geometry.dispose();
        (this.particleGroup?.mesh.material as THREE.Material).dispose();
    }
}