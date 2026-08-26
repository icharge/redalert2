import { ModelQuality } from "@/engine/renderable/entity/unit/ModelQuality";
import { isNotNullOrUndefined } from "@/util/typeGuard";
import { VxlGeometryMonotoneBuilder } from "@/engine/renderable/builder/vxlGeometry/VxlGeometryMonotoneBuilder";
import * as THREE from 'three';
interface GeometryCache {
    get(key: unknown): THREE.BufferGeometry | undefined;
    set(key: unknown, value: THREE.BufferGeometry): void;
    loadFromStorage(section: unknown, param: unknown): Promise<unknown>;
    persistToStorage(section: unknown, param: unknown, result: unknown): Promise<void>;
    clear(): void;
    clearStorage(): Promise<void>;
    clearOtherModStorage(): Promise<void>;
}
export class VxlGeometryPool {
    cache: GeometryCache;
    modelQuality: ModelQuality;
    constructor(cache: GeometryCache, modelQuality = ModelQuality.High) {
        this.cache = cache;
        this.modelQuality = modelQuality;
    }
    setModelQuality(modelQuality) {
        this.modelQuality = modelQuality;
    }
    getModelQuality() {
        return this.modelQuality;
    }
    async loadFromStorage(data: { sections: unknown[] }, param: unknown) {
        let results = await Promise.all(data.sections.map((section) => this.cache.loadFromStorage(section, param)));
        return results.every(isNotNullOrUndefined);
    }
    async persistToStorage(data: { sections: unknown[] }, param: unknown, results: unknown[]) {
        for (let i = 0; i < data.sections.length; i++) {
            const section = data.sections[i];
            await this.cache.persistToStorage(section, param, results[i]);
        }
    }
    clear() {
        this.cache.clear();
    }
    async clearStorage() {
        await this.cache.clearStorage();
    }
    async clearOtherModStorage() {
        await this.cache.clearOtherModStorage();
    }
    get(key: unknown) {
        let geometry = this.cache.get(key);
        if (!geometry) {
            geometry = new VxlGeometryMonotoneBuilder().build(key);
            this.cache.set(key, geometry);
        }
        return geometry;
    }
}