import SPE from './speRuntime';
import type * as THREE from 'three';
let shaderPatched = false;
function patchShaderSource(source: string): string {
    return source
        .replace(/uniform sampler2D texture;/g, 'uniform sampler2D particleTexture;')
        .replace(/texture2D\(\s*texture\s*,/g, 'texture2D( particleTexture,');
}
function patchShaders(): void {
    if (shaderPatched) {
        return;
    }
    shaderPatched = true;
    const speAny = SPE as any;
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
    const speAny = SPE as any;
    if (!speAny.Emitter?.prototype) {
        return;
    }
    const origAssignRotationValue = speAny.Emitter.prototype._assignRotationValue;
    speAny.Emitter.prototype._assignRotationValue = function (index: number) {
        if (!this.rotation._angle && !this.rotation._angleSpread) {
            return;
        }
        origAssignRotationValue.call(this, index);
    };
    const origAssignColorValue = speAny.Emitter.prototype._assignColorValue;
    speAny.Emitter.prototype._assignColorValue = function (index: number) {
        if (!this.color._spread[0].manhattanLength() && !this.color._spread.some((v: any) => v.x || v.y || v.z)) {
            const numItems = this.color._value.length;
            const colors: number[] = [];
            for (let i = 0; i < numItems; ++i) {
                colors.push(this.color._value[i].getHex());
            }
            this.attributes.color.typedArray.setVec4Components(index, colors[0], colors[1], colors[2], colors[3]);
            return;
        }
        origAssignColorValue.call(this, index);
    };
    const origAssignAbsLifetimeValue = speAny.Emitter.prototype._assignAbsLifetimeValue;
    speAny.Emitter.prototype._assignAbsLifetimeValue = function (index: number, propName: string) {
        const prop = this[propName];
        const utils = speAny.utils;
        if (!prop._spread[0] && utils.arrayValuesAreEqual(prop._spread)) {
            this.attributes[propName].typedArray.setVec4Components(index,
                prop._value[0],
                prop._value[1],
                prop._value[2],
                prop._value[3]);
            return;
        }
        origAssignAbsLifetimeValue.call(this, index, propName);
    };
}
export function patchSpeGroup(group: any): any {
    patchShaders();
    patchEmitterBehaviors();
    const material = group?.material ?? group?.mesh?.material;
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
        for (const attribute of Object.values(attributes) as Array<{
            bufferAttribute?: THREE.BufferAttribute;
        }>) {
            if (attribute.bufferAttribute && !(attribute.bufferAttribute as any).updateRange) {
                (attribute.bufferAttribute as any).updateRange = { offset: 0, count: -1 };
            }
        }
    }
    return group;
}
