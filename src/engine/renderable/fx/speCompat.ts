import SPE from './speRuntime';
import type * as THREE from 'three';
let shaderPatched = false;
function patchShaderSource(source: string): string {
    return source
        .replace(/uniform sampler2D texture;/g, 'uniform sampler2D particleTexture;')
        .replace(/texture2D\(\s*texture\s*,/g, 'texture2D( particleTexture,');
}
interface SpeShaderChunks {
    shaderChunks?: {
        uniforms?: unknown;
    };
    shaders?: {
        vertex?: unknown;
        fragment?: unknown;
    };
    utils?: {
        arrayValuesAreEqual(values: unknown[]): boolean;
    };
    Emitter?: {
        prototype?: {
            _assignRotationValue?(this: SpeEmitter, index: number): void;
            _assignColorValue?(this: SpeEmitter, index: number): void;
            _assignAbsLifetimeValue?(this: SpeEmitter, index: number, propName: string): void;
        };
    };
}
interface SpeVector3 {
    x: number;
    y: number;
    z: number;
    manhattanLength(): number;
}
interface SpeEmitter {
    rotation: {
        _angle?: unknown;
        _angleSpread?: unknown;
    };
    color: {
        _spread: SpeVector3[];
        _value: {
            getHex(): number;
        }[];
    };
    attributes: Record<string, {
        typedArray: {
            setVec4Components(index: number, ...values: number[]): void;
        };
    }>;
    [key: string]: unknown;
}
function patchShaders(): void {
    if (shaderPatched) {
        return;
    }
    shaderPatched = true;
    const speAny = SPE as unknown as SpeShaderChunks;
    if (typeof speAny.shaderChunks?.uniforms === 'string') {
        speAny.shaderChunks.uniforms = patchShaderSource(speAny.shaderChunks.uniforms);
    }
    if (typeof speAny.shaders?.vertex === 'string') {
        speAny.shaders.vertex = patchShaderSource(speAny.shaders.vertex);
    }
    if (typeof speAny.shaders?.fragment === 'string') {
        speAny.shaders.fragment = patchShaderSource(speAny.shaders.fragment);
    }
}
let emitterPatched = false;
function patchEmitterBehaviors(): void {
    if (emitterPatched) {
        return;
    }
    emitterPatched = true;
    const speAny = SPE as unknown as SpeShaderChunks;
    if (!speAny.Emitter?.prototype) {
        return;
    }
    const origAssignRotationValue = speAny.Emitter.prototype._assignRotationValue;
    speAny.Emitter.prototype._assignRotationValue = function (index: number) {
        if (!this.rotation._angle && !this.rotation._angleSpread) {
            return;
        }
        origAssignRotationValue?.call(this, index);
    };
    const origAssignColorValue = speAny.Emitter.prototype._assignColorValue;
    speAny.Emitter.prototype._assignColorValue = function (index: number) {
        if (!this.color._spread[0].manhattanLength() && !this.color._spread.some((v) => v.x || v.y || v.z)) {
            const numItems = this.color._value.length;
            const colors: number[] = [];
            for (let i = 0; i < numItems; ++i) {
                colors.push(this.color._value[i].getHex());
            }
            this.attributes.color.typedArray.setVec4Components(index, colors[0], colors[1], colors[2], colors[3]);
            return;
        }
        origAssignColorValue?.call(this, index);
    };
    const origAssignAbsLifetimeValue = speAny.Emitter.prototype._assignAbsLifetimeValue;
    speAny.Emitter.prototype._assignAbsLifetimeValue = function (index: number, propName: string) {
        const prop = this[propName] as { _spread: unknown[]; _value: number[] };
        const utils = speAny.utils;
        if (!prop._spread[0] && utils?.arrayValuesAreEqual(prop._spread)) {
            const value = this.attributes[propName].typedArray;
            value.setVec4Components(index, prop._value[0], prop._value[1], prop._value[2], prop._value[3]);
            return;
        }
        origAssignAbsLifetimeValue?.call(this, index, propName);
    };
}
interface SpeMaterial {
    vertexShader?: string;
    fragmentShader?: string;
    uniforms?: Record<string, unknown>;
    needsUpdate: boolean;
}
interface SpeGroup {
    material?: unknown;
    mesh?: {
        material?: unknown;
    };
    attributes?: Record<string, {
        bufferAttribute?: THREE.BufferAttribute;
    }>;
}
export function patchSpeGroup(group: SpeGroup): SpeGroup {
    patchShaders();
    patchEmitterBehaviors();
    const material = (group?.material ?? group?.mesh?.material) as SpeMaterial | undefined;
    if (material) {
        if (typeof material.vertexShader === 'string') {
            material.vertexShader = patchShaderSource(material.vertexShader);
        }
        if (typeof material.fragmentShader === 'string') {
            material.fragmentShader = patchShaderSource(material.fragmentShader);
        }
        if (material.uniforms?.texture && !material.uniforms.particleTexture) {
            material.uniforms.particleTexture = material.uniforms.texture;
            delete material.uniforms.texture;
        }
        material.needsUpdate = true;
    }
    const attributes = group?.attributes;
    if (attributes) {
        for (const attribute of Object.values(attributes)) {
            if (attribute.bufferAttribute && !(attribute.bufferAttribute as { updateRange?: unknown }).updateRange) {
                (attribute.bufferAttribute as unknown as { updateRange: unknown }).updateRange = { offset: 0, count: -1 };
            }
        }
    }
    return group;
}