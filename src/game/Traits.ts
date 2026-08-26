export interface Trait {
    getHash?(): number;
    debugGetState?(): unknown;
    dispose?(): void;
    [key: string]: unknown;
    [key: symbol]: (...args: any[]) => void;
}
export class Traits {
    private allTraits: Trait[] = [];
    private traitsByTypeCache: Map<unknown, Trait[]> = new Map();
    add(trait: object): void {
        this.allTraits.push(trait as unknown as Trait);
        this.traitsByTypeCache.clear();
    }
    addToFront(trait: object): void {
        this.allTraits.unshift(trait as unknown as Trait);
        this.traitsByTypeCache.clear();
    }
    remove(trait: object): void {
        const index = this.allTraits.indexOf(trait as unknown as Trait);
        if (index !== -1) {
            this.allTraits.splice(index, 1);
            this.traitsByTypeCache.clear();
        }
    }
    filter(type: unknown): Trait[] {
        let cached = this.traitsByTypeCache.get(type);
        if (cached) {
            return cached;
        }
        cached = typeof type === 'function'
            ? this.allTraits.filter(trait => trait instanceof (type as Function))
            : this.allTraits.filter(trait => this.traitImplements(trait, type));
        this.traitsByTypeCache.set(type, cached);
        return cached;
    }
    get(type: unknown): Trait {
        const trait = this.find(type);
        if (!trait) {
            throw new Error("No matching trait found");
        }
        return trait;
    }
    find(type: unknown): Trait | undefined {
        return this.filter(type)[0];
    }
    getAll(): Trait[] {
        return this.allTraits;
    }
    private traitImplements(trait: Trait, type: unknown): boolean {
        for (const prop of Object.getOwnPropertyNames(type as object)) {
            const key = (type as Record<string, symbol>)[prop];
            if ((trait as unknown as Record<symbol, unknown>)[key] === undefined) {
                return false;
            }
        }
        return true;
    }
    clear(): void {
        this.allTraits.length = 0;
        this.traitsByTypeCache.clear();
    }
    dispose(): void {
        this.getAll().forEach(trait => trait.dispose?.());
        this.clear();
    }
}