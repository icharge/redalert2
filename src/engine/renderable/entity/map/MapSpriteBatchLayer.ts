import { Coords } from "@/game/Coords";
import { ImageFinder } from "@/engine/ImageFinder";
import { BatchShpBuilder } from "@/engine/renderable/builder/BatchShpBuilder";
import { ShpAggregator } from "@/engine/renderable/builder/ShpAggregator";
import { MapSpriteTranslation } from "@/engine/renderable/MapSpriteTranslation";
import { ShadowRenderable } from "@/engine/renderable/ShadowRenderable";
import { isNotNullOrUndefined } from "@/util/typeGuard";
import type { ShpFile } from "@/data/ShpFile";
import type { Palette } from "@/data/Palette";
import type { ShpTextureAtlas } from "@/engine/renderable/builder/ShpTextureAtlas";
import * as THREE from "three";
interface BatchShpSpec {
    [key: string]: unknown;
    shpFile: ShpFile;
    frameNo: number;
    depth: boolean;
    flat: boolean;
    position: THREE.Vector3;
    offset: THREE.Vector2;
    lightMult?: THREE.Vector3;
}
interface ObjectSpecs {
    main: BatchShpSpec;
    shadow?: BatchShpSpec;
}
interface Lighting {
    compute(type: string, tile: unknown): THREE.Vector3;
}
interface BatchObjectArt {
    imageName: string;
    useTheaterExtension: boolean;
    paletteType: string;
    customPaletteName?: string;
    lightingType: string;
    flat: boolean;
    hasShadow: boolean;
    getDrawOffset(): THREE.Vector2;
}
interface BatchObject {
    art: BatchObjectArt;
    rules: unknown;
    name: string;
    tile: unknown;
    position: {
        worldPosition: THREE.Vector3;
    };
    getFoundation(): {
        width: number;
        height: number;
    };
}
interface AggregatedShpData {
    file: ShpFile;
    imageIndexes: Map<ShpFile, number>;
}
export class MapSpriteBatchLayer {
    private label: string;
    private spriteUseDepth: (obj: BatchObject) => number;
    private theater: {
        getPalette(paletteType: string, customPaletteName?: string): unknown;
    };
    private art: {
        getObject(name: string, type: unknown): BatchObjectArt;
    };
    private imageFinder: ImageFinder;
    private camera: THREE.Camera;
    private lighting: Lighting;
    private shpAggregator: ShpAggregator;
    private textureCache: Map<ShpFile, ShpTextureAtlas>;
    private batchShpSpecsByObject: Map<unknown, ObjectSpecs>;
    private batchShpBuilders: Map<string, BatchShpBuilder[]>;
    private shadowBatchShpBuilders: BatchShpBuilder[];
    private batchedObjectRules: Set<unknown>;
    private aggregatedImageData: AggregatedShpData;
    private target?: THREE.Object3D;
    public meshRenderOrder: number = 0;
    public meshNoDepth: boolean = false;
    constructor(label: string, batchedObjectRules: unknown[], spriteUseDepth: (obj: BatchObject) => number, theater: {
        getPalette(paletteType: string, customPaletteName?: string): unknown;
    }, art: {
        getObject(name: string, type: unknown): BatchObjectArt;
    }, imageFinder: ImageFinder, camera: THREE.Camera, lighting: Lighting, shpAggregator: ShpAggregator) {
        this.label = label;
        this.spriteUseDepth = spriteUseDepth;
        this.theater = theater;
        this.art = art;
        this.imageFinder = imageFinder;
        this.camera = camera;
        this.lighting = lighting;
        this.shpAggregator = shpAggregator;
        this.textureCache = new Map();
        this.batchShpSpecsByObject = new Map();
        this.batchShpBuilders = new Map();
        this.shadowBatchShpBuilders = [];
        this.batchedObjectRules = new Set(batchedObjectRules);
        this.aggregatedImageData = this.createAggregatedShpFile(`agg_${label}.shp`);
    }
    get3DObject(): THREE.Object3D | undefined {
        return this.target;
    }
    create3DObject(): void {
        let obj = this.get3DObject();
        if (!obj) {
            obj = new THREE.Object3D();
            obj.name = this.label;
            obj.matrixAutoUpdate = false;
            this.target = obj;
        }
    }
    private createAggregatedShpFile(filename: string): AggregatedShpData {
        const shpFrameInfos = [...this.batchedObjectRules.values()]
            .map((rule) => {
            const objectArt = this.art.getObject((rule as { name: string }).name, (rule as { type: unknown }).type);
            let imageData;
            try {
                imageData = this.imageFinder.findByObjectArt(objectArt);
            }
            catch (error) {
                if (error instanceof ImageFinder.MissingImageError)
                    return;
                throw error;
            }
            return ShpAggregator.getShpFrameInfo(imageData as ShpFile, objectArt.hasShadow);
        })
            .filter(isNotNullOrUndefined);
        return this.shpAggregator.aggregate(shpFrameInfos, filename);
    }
    update(deltaTime: number): void { }
    updateLighting(): void {
        this.batchShpSpecsByObject.forEach((specs, obj) => {
            specs.main.lightMult?.copy(this.lighting.compute((obj as BatchObject).art.lightingType, (obj as BatchObject).tile));
        });
        [...this.batchShpBuilders.values()]
            .flat()
            .forEach((builder) => builder.updateLighting());
    }
    shouldBeBatched(obj: BatchObject): boolean {
        return this.batchedObjectRules.has(obj.rules);
    }
    private getBatchKey(obj: BatchObject): string {
        return obj.art.paletteType + "_" + obj.art.customPaletteName;
    }
    addObject(obj: BatchObject): void {
        const batchKey = this.getBatchKey(obj);
        let builders = this.batchShpBuilders.get(batchKey);
        if (!builders) {
            builders = [];
            this.batchShpBuilders.set(batchKey, builders);
        }
        let availableBuilder = builders.find((builder) => !builder.isFull());
        if (!availableBuilder) {
            if (!this.get3DObject())
                throw new Error("Not implemented");
            const palette = this.theater.getPalette(obj.art.paletteType, obj.art.customPaletteName);
            const newBuilder = new BatchShpBuilder(this.aggregatedImageData.file, palette as Palette, this.camera, this.textureCache, undefined, undefined, undefined, Coords.ISO_WORLD_SCALE);
            builders.push(newBuilder);
            const mesh = newBuilder.build();
            mesh.renderOrder = this.meshRenderOrder;
            if (this.meshNoDepth) {
                const mat = mesh.material as THREE.Material;
                mat.depthTest = false;
                mat.depthWrite = false;
            }
            this.get3DObject()!.add(mesh);
            availableBuilder = newBuilder;
        }
        const mainSpec = this.buildBatchShpSpec(obj, this.aggregatedImageData);
        availableBuilder.add(mainSpec);
        let shadowSpec: BatchShpSpec | undefined;
        if (obj.art.hasShadow) {
            let shadowBuilder = this.shadowBatchShpBuilders.find((builder) => !builder.isFull());
            if (!shadowBuilder) {
                if (!this.get3DObject())
                    throw new Error("Not implemented");
                const newShadowBuilder = new BatchShpBuilder(this.aggregatedImageData.file, ShadowRenderable.getOrCreateShadowPalette(), this.camera, this.textureCache, 0.5, true, undefined, Coords.ISO_WORLD_SCALE);
                this.shadowBatchShpBuilders.push(newShadowBuilder);
                const shadowMesh = newShadowBuilder.build();
                shadowMesh.renderOrder = this.meshRenderOrder;
                if (this.meshNoDepth) {
                    const mat = shadowMesh.material as THREE.Material;
                    mat.depthTest = false;
                    mat.depthWrite = false;
                }
                this.get3DObject()!.add(shadowMesh);
                shadowBuilder = newShadowBuilder;
            }
            shadowSpec = this.buildShadowBatchShpSpec(mainSpec, this.aggregatedImageData);
            shadowBuilder.add(shadowSpec);
        }
        this.batchShpSpecsByObject.set(obj, { main: mainSpec, shadow: shadowSpec });
    }
    private buildBatchShpSpec(obj: BatchObject, aggregatedData: AggregatedShpData): BatchShpSpec {
        const foundation = obj.getFoundation();
        const spriteTranslation = new MapSpriteTranslation(foundation.width, foundation.height);
        const worldPosition = obj.position.worldPosition.clone();
        const { spriteOffset, anchorPointWorld } = spriteTranslation.compute();
        worldPosition.x += anchorPointWorld.x;
        worldPosition.z += anchorPointWorld.y;
        const imageData = this.imageFinder.findByObjectArt(obj.art);
        const imageIndex = aggregatedData.imageIndexes.get(imageData as ShpFile);
        if (imageIndex === undefined) {
            throw new Error("SHP file not found in aggregated image data");
        }
        return {
            shpFile: imageData as ShpFile,
            frameNo: imageIndex,
            depth: this.spriteUseDepth(obj) !== 0,
            flat: obj.art.flat,
            position: worldPosition,
            offset: spriteOffset.clone().add(obj.art.getDrawOffset()),
            lightMult: this.lighting.compute(obj.art.lightingType, obj.tile),
        };
    }
    private buildShadowBatchShpSpec(mainSpec: BatchShpSpec, aggregatedData: AggregatedShpData): BatchShpSpec {
        const imageIndex = aggregatedData.imageIndexes.get(mainSpec.shpFile);
        if (imageIndex === undefined) {
            throw new Error("SHP file not found in aggregated image data");
        }
        return {
            ...mainSpec,
            position: mainSpec.position.clone().add(new THREE.Vector3(0, 0.1, 0)),
            flat: true,
            frameNo: imageIndex + aggregatedData.file.numImages / 2,
            lightMult: undefined,
        };
    }
    removeObject(obj: BatchObject): void {
        const specs = this.batchShpSpecsByObject.get(obj);
        if (!specs)
            return;
        const batchKey = this.getBatchKey(obj);
        const builders = this.batchShpBuilders.get(batchKey);
        const mainBuilder = builders?.find((builder) => builder.has(specs.main));
        if (mainBuilder) {
            mainBuilder.remove(specs.main);
            if (mainBuilder.isEmpty() && builders!.length > 1) {
                this.get3DObject()?.remove(mainBuilder.build());
                mainBuilder.dispose();
                builders?.splice(builders.indexOf(mainBuilder), 1);
            }
            if (specs.shadow) {
                const shadowBuilder = this.shadowBatchShpBuilders.find((builder) => builder.has(specs.shadow));
                shadowBuilder?.remove(specs.shadow);
                if (shadowBuilder?.isEmpty() && this.shadowBatchShpBuilders.length > 1) {
                    this.get3DObject()?.remove(shadowBuilder.build());
                    shadowBuilder.dispose();
                    this.shadowBatchShpBuilders.splice(this.shadowBatchShpBuilders.indexOf(shadowBuilder), 1);
                }
            }
            this.batchShpSpecsByObject.delete(obj);
        }
    }
    hasObject(obj: BatchObject): boolean {
        return this.batchShpSpecsByObject.has(obj);
    }
    getObjectFrameCount(obj: BatchObject): number {
        const specs = this.batchShpSpecsByObject.get(obj);
        if (!specs) {
            throw new Error(`Batch SHP spec for object "${obj.name}" not found`);
        }
        return specs.main.shpFile.numImages * (specs.shadow ? 0.5 : 1);
    }
    setObjectFrame(obj: BatchObject, frameIndex: number): void {
        const specs = this.batchShpSpecsByObject.get(obj);
        if (!specs) {
            throw new Error(`Batch SHP spec for object "${obj.name}" not found`);
        }
        if (frameIndex >= specs.main.shpFile.numImages * (specs.shadow ? 0.5 : 1)) {
            return;
        }
        const baseImageIndex = this.aggregatedImageData.imageIndexes.get(specs.main.shpFile);
        specs.main.frameNo = baseImageIndex + frameIndex;
        if (specs.shadow) {
            specs.shadow.frameNo = specs.main.frameNo + this.aggregatedImageData.file.numImages / 2;
        }
        const batchKey = this.getBatchKey(obj);
        const mainBuilder = this.batchShpBuilders
            .get(batchKey)
            ?.find((builder) => builder.has(specs.main));
        mainBuilder?.update(specs.main);
        if (specs.shadow) {
            const shadowBuilder = this.shadowBatchShpBuilders.find((builder) => builder.has(specs.shadow));
            shadowBuilder?.update(specs.shadow);
        }
    }
    dispose(): void {
        [
            ...this.batchShpBuilders.values(),
            ...this.shadowBatchShpBuilders,
        ]
            .flat()
            .forEach((builder) => builder.dispose());
        [...this.textureCache.values()].forEach((texture) => texture.dispose());
        this.textureCache.clear();
    }
}