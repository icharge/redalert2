export class Renderable {
    create3DObject?(): void;
    get3DObject?(): import('three').Object3D | undefined;
    update?(deltaTime: number, ...args: unknown[]): void;
    destroy?(): void;
    onCreate?(manager: unknown): void;
    onRemove?(manager: unknown): unknown;
    setPosition?(position: { x: number; y: number; z: number }): void;
    dispose?(): void;
    updateLighting?(): void;
    selectionModel?: any;
    constructor() {
    }
}