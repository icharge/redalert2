import { Coords } from "@/game/Coords";
import { TextureUtils } from "@/engine/gfx/TextureUtils";
import { TmpDrawable } from "@/engine/gfx/drawable/TmpDrawable";
import { TextureAtlas } from "@/engine/gfx/TextureAtlas";
import { SpriteUtils } from "@/engine/gfx/SpriteUtils";
import { Anim } from "@/engine/renderable/entity/Anim";
import { LightingType } from "@/engine/type/LightingType";
import { CompositeDisposable } from "@/util/disposable/CompositeDisposable";
import { BufferGeometryUtils } from "@/engine/gfx/BufferGeometryUtils";
import { PaletteBasicMaterial } from "@/engine/gfx/material/PaletteBasicMaterial";
import { getRandomInt } from "@/util/math";
import * as THREE from "three";
export class MapTileLayer {
    private theater: any;
    private art: any;
    private imageFinder: any;
    private camera: any;
    private debugFrame: any;
    private gameSpeed: any;
    private worldSound: any;
    private lighting: any;
    private useSpriteBatching: any;
    private tileIndexes: Map<any, any>;
    private tileAnimLightMultsByTile: Map<any, any>;
    private tileDrawableMap: Map<any, any>;
    private disposables: CompositeDisposable;
    private allTiles: any[];
    private target: any;
    private colorMultAttribute: any;
    private uvAttribute: any;
    private textureAtlas: any;
    private anims: any[];
    constructor(mapData: any, theater: any, art: any, imageFinder: any, camera: any, debugFrame: any, gameSpeed: any, worldSound: any, lighting: any, useSpriteBatching: any) {
        this.theater = theater;
        this.art = art;
        this.imageFinder = imageFinder;
        this.camera = camera;
        this.debugFrame = debugFrame;
        this.gameSpeed = gameSpeed;
        this.worldSound = worldSound;
        this.lighting = lighting;
        this.useSpriteBatching = useSpriteBatching;
        this.tileIndexes = new Map();
        this.tileAnimLightMultsByTile = new Map();
        this.tileDrawableMap = new Map();
        this.disposables = new CompositeDisposable();
        this.allTiles = mapData.tiles.getAll();
    }
    get3DObject(): any {
        return this.target;
    }
    create3DObject(): void {
        let object3D = this.get3DObject();
        if (!object3D) {
            object3D = new (THREE as any).Object3D();
            object3D.name = "map_tile_layer";
            object3D.matrixAutoUpdate = false;
            this.target = object3D;
            this.createTileObjects(object3D);
        }
    }
    createTileObjects(parent: any): void {
        try {
            console.log('[MapTileLayer] createTileObjects start');
        }
        catch { }
        const tmpImageMap = new Map();
        const tileImageMap = new Map();
        const isoPalette = this.theater.isoPalette;
        const paletteTexture = TextureUtils.textureFromPalette(isoPalette);
        const tileSets = this.theater.tileSets;
        const validTiles: any[] = [];
        for (const tile of this.allTiles) {
            const tileNum = tile.tileNum;
            let tileData = tileSets.getTile(tileNum);
            let subTile = tile.subTile;
            if (!tileData) {
                console.warn('[MapTileLayer] missing tileData for tile, falling back to tileNum 0 (Clear)', tile);
                // Upstream has no fallback here either (it throws) — the original
                // client assumes every referenced tile always ships with art. That
                // assumption doesn't hold for incomplete/stripped game-file copies,
                // so render best-effort with the always-present base tile instead
                // of leaving a black void where the map's real art is missing.
                tileData = tileSets.getTile(0);
                subTile = 0;
            }
            if (!tileData) {
                continue;
            }
            let tmpFile = tileData.getTmpFile(subTile, getRandomInt);
            if (!tmpFile || subTile >= tmpFile.images.length) {
                console.warn('[MapTileLayer] bad tmpFile or subTile, falling back to tileNum 0 (Clear)', { tile, tmpFileExists: !!tmpFile });
                const fallbackTileData = tileSets.getTile(0);
                tmpFile = fallbackTileData?.getTmpFile(0, getRandomInt);
                subTile = 0;
                if (!tmpFile || subTile >= tmpFile.images.length) {
                    continue;
                }
            }
            const tmpImage = tmpFile.images[subTile];
            tileImageMap.set(tile, tmpImage);
            validTiles.push(tile);
            if (!tmpImageMap.get(tmpImage)) {
                const drawable = new TmpDrawable().draw(tmpImage, tmpFile.blockWidth, tmpFile.blockHeight);
                tmpImageMap.set(tmpImage, drawable);
            }
        }
        const textureAtlas = new TextureAtlas();
        const drawables: any[] = [];
        tmpImageMap.forEach((drawable) => {
            drawables.push(drawable);
        });
        // NearestMipmapLinear (not plain NearestFilter): tile sprites use a
        // hard alphaTest cutout to their diamond shape, and the whole map
        // can render at a small fraction of its source texel resolution
        // (small window / zoomed out) - with no mip chain, that cutout edge
        // aliases into visible dashed lines tracing every tile boundary,
        // worse the smaller the map renders on screen. Mip averaging softens
        // the alpha values feeding that cutout as tiles shrink, same fix
        // class as mipmapping any alpha-tested foliage/fence billboard.
        // magFilter is unaffected (still NearestFilter, crisp when zoomed in).
        textureAtlas.pack(drawables, { minFilter: THREE.NearestMipmapLinearFilter });
        this.textureAtlas = textureAtlas;
        try {
            console.log('[MapTileLayer] textureAtlas packed', { drawables: drawables.length });
        }
        catch { }
        this.disposables.add(textureAtlas);
        const geometries: any[] = [];
        const lightingData: number[] = [];
        for (let i = 0; i < validTiles.length; i++) {
            const tile = validTiles[i];
            const tmpImage = tileImageMap.get(tile)!;
            let offsetX = 0;
            let offsetY = 0;
            if (tmpImage.hasExtraData) {
                offsetX += Math.max(0, tmpImage.x - tmpImage.extraX);
                offsetY += Math.max(0, tmpImage.y - tmpImage.extraY);
            }
            const worldPos = Coords.tile3dToWorld(tile.rx, tile.ry, tile.z);
            const drawable = tmpImageMap.get(tmpImage);
            this.tileDrawableMap.set(tile, drawable);
            const spriteGeometry = SpriteUtils.createSpriteGeometry({
                texture: textureAtlas.getTexture(),
                textureArea: textureAtlas.getImageRect(drawable),
                align: { x: 0, y: -1 },
                offset: { x: -offsetX, y: -offsetY },
                camera: this.camera,
                scale: Coords.ISO_WORLD_SCALE,
            });
            spriteGeometry.applyMatrix4(new (THREE as any).Matrix4().makeTranslation(worldPos.x, worldPos.y, worldPos.z));
            geometries.push(spriteGeometry);
            const { x, y, z } = this.lighting.compute(LightingType.Full, tile);
            lightingData.push(x, y, z);
            this.tileIndexes.set(tile, i);
        }
        const material = new PaletteBasicMaterial({
            map: textureAtlas.getTexture(),
            palette: paletteTexture,
            alphaTest: 0.5,
            flatShading: true,
            useVertexColorMult: true,
        });
        const mergedGeometry = BufferGeometryUtils.mergeBufferGeometries(geometries);
        try {
            console.log('[MapTileLayer] mergedGeometry', { geometries: geometries.length, vertexCount: mergedGeometry.getAttribute("position").count });
        }
        catch { }
        const vertexCount = mergedGeometry.getAttribute("position").count;
        const positionAttribute = mergedGeometry.getAttribute("position");
        const uvAttribute = mergedGeometry.getAttribute("uv");
        this.uvAttribute = uvAttribute;
        let invalidPositionValues = 0;
        for (let i = 0; i < positionAttribute.array.length; i++) {
            if (!Number.isFinite(positionAttribute.array[i])) {
                invalidPositionValues++;
            }
        }
        let invalidUvValues = 0;
        for (let i = 0; i < uvAttribute.array.length; i++) {
            if (!Number.isFinite(uvAttribute.array[i])) {
                invalidUvValues++;
            }
        }
        console.log('[MapTileLayer] geometry sanity', {
            invalidPositionValues,
            invalidUvValues,
        });
        if (vertexCount !== (SpriteUtils.VERTICES_PER_SPRITE * lightingData.length) / 3) {
            throw new Error("Vertex count mismatch");
        }
        const colorMultBuffer = new Float32Array(4 * vertexCount);
        this.updateColorMultBuffer(lightingData, colorMultBuffer);
        const colorMultAttribute = new (THREE as any).BufferAttribute(colorMultBuffer, 4);
        mergedGeometry.setAttribute("vertexColorMult", colorMultAttribute);
        this.colorMultAttribute = colorMultAttribute;
        geometries.forEach((geometry) => geometry.dispose());
        const mesh = new (THREE as any).Mesh(mergedGeometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = -2;
        try {
            const mapTex: any = (material as any).map;
            const palTex: any = (material as any).uniforms?.palette?.value;
            const uvAttr: any = mergedGeometry.getAttribute("uv");
            console.log('[MapTileLayer] material debug', {
                materialType: (material as any).type,
                hasMap: !!mapTex,
                mapSize: mapTex && mapTex.image ? { w: mapTex.image.width, h: mapTex.image.height } : null,
                mapFlipY: mapTex ? mapTex.flipY : undefined,
                paletteReady: !!palTex,
                paletteSize: palTex && palTex.image ? { w: palTex.image.width, h: palTex.image.height } : null,
                paletteFlipY: palTex ? palTex.flipY : undefined,
                hasUV: !!uvAttr,
                uvCount: uvAttr ? uvAttr.count : 0,
                defines: (material as any).defines,
            });
        }
        catch { }
        parent.add(mesh);
        this.disposables.add(mergedGeometry, material);
        const animations: any[] = [];
        for (const tile of validTiles) {
            const tileNum = tile.tileNum;
            const tileData = tileSets.getTile(tileNum);
            if (!tileData)
                return;
            const animData = tileData.getAnimation();
            if (animData && tile.subTile === animData.subTile) {
                const lightMult = this.lighting
                    .compute(LightingType.Full, tile)
                    .addScalar(-1);
                this.tileAnimLightMultsByTile.set(tile, lightMult);
                const anim = new Anim(animData.name, this.art.getAnimation(animData.name), {
                    x: animData.offsetX,
                    y: animData.offsetY + (Coords.ISO_TILE_SIZE + 1) / 2,
                }, this.imageFinder, this.theater, this.camera, this.debugFrame, this.gameSpeed, this.useSpriteBatching, lightMult, this.worldSound, isoPalette);
                const worldPos = Coords.tile3dToWorld(tile.rx, tile.ry, tile.z);
                anim.setPosition(worldPos);
                anim.create3DObject();
                animations.push(anim);
                parent.add(anim.get3DObject());
                this.disposables.add(anim);
            }
        }
        this.anims = animations;
    }
    update(deltaTime: number): void {
        for (const anim of this.anims) {
            anim.update(deltaTime);
        }
    }
    // Tier 1 repaint: swaps a tile's art for art already resident in the
    // texture atlas by rewriting its two half-rect quads' UVs in place - no
    // geometry rebuild, no atlas repack. Returns false if newDrawable isn't
    // in the atlas yet (Tier 2 - full repack - not implemented; caller must
    // fall back to that or refuse the paint). Shares tileIndexes with
    // updateLighting, so a lighting pass after a repaint still tints the
    // right vertices.
    repaintTile(tile: any, newDrawable: any): boolean {
        const tileIndex = this.tileIndexes.get(tile);
        if (tileIndex === undefined) {
            return false;
        }
        let newTextureArea: { x: number; y: number; width: number; height: number };
        try {
            newTextureArea = this.textureAtlas.getImageRect(newDrawable);
        }
        catch {
            return false;
        }
        const imageSize = this.textureAtlas.getTexture().image as { width: number; height: number };
        // Mirrors SpriteUtils.createSpriteGeometry's own (non-depth) split:
        // each tile sprite is two equal-width half-rect quads, first 4
        // vertices left, last 4 right (§3.3's UV finding). Splitting the
        // atlas rect exactly in half reproduces that split; camera rotation
        // and scale cancel out of createSpriteGeometry's splitX derivation
        // algebraically, so this needs neither.
        const splitWidth = newTextureArea.width / 2;
        const leftArea = { x: newTextureArea.x, y: newTextureArea.y, width: splitWidth, height: newTextureArea.height };
        const rightArea = { x: newTextureArea.x + splitWidth, y: newTextureArea.y, width: newTextureArea.width - splitWidth, height: newTextureArea.height };
        const uvArray = this.uvAttribute.array as Float32Array;
        SpriteUtils.writeIndexedRectUvsIntoBuffer(uvArray, tileIndex * 2, leftArea, imageSize);
        SpriteUtils.writeIndexedRectUvsIntoBuffer(uvArray, tileIndex * 2 + 1, rightArea, imageSize);
        this.uvAttribute.needsUpdate = true;
        this.tileDrawableMap.set(tile, newDrawable);
        return true;
    }
    // Exposes the Tier-1 repaint lookup (docs/map-editor-feasibility-and-
    // design.md §4 design decision 2, Phase 2 step 7): the atlas-resident
    // drawable already backing an existing map tile's art, keyed by Tile
    // object identity (the same references TileCollection hands out via
    // getAll()/getByMapCoords()). Paint-mode UI always sources its "brush"
    // from an already-placed tile's own drawable via this method, so the
    // result - when found - never requires an atlas repack to paint with.
    getDrawableForTile(tile: any): any | undefined {
        return this.tileDrawableMap.get(tile);
    }
    updateLighting(tiles?: any[]): void {
        if (tiles) {
            for (const tile of tiles) {
                const tileIndex = this.tileIndexes.get(tile);
                if (tileIndex !== undefined) {
                    const { x, y, z } = this.lighting.compute(LightingType.Full, tile);
                    this.updateColorMultBufferAtIndex(tileIndex, x, y, z, this.colorMultAttribute.array);
                }
                const animLightMult = this.tileAnimLightMultsByTile.get(tile);
                if (animLightMult) {
                    animLightMult.copy(this.lighting.compute(LightingType.Full, tile));
                }
            }
            this.colorMultAttribute.needsUpdate = true;
        }
        else {
            const lightingData: number[] = [];
            for (const tile of this.allTiles) {
                const { x, y, z } = this.lighting.compute(LightingType.Full, tile);
                lightingData.push(x, y, z);
            }
            this.updateColorMultBuffer(lightingData, this.colorMultAttribute.array);
            this.colorMultAttribute.needsUpdate = true;
            this.tileAnimLightMultsByTile.forEach((lightMult, tile) => {
                lightMult.copy(this.lighting.compute(LightingType.Full, tile));
            });
        }
    }
    private updateColorMultBuffer(lightingData: number[], buffer: Float32Array): void {
        const verticesPerSprite = SpriteUtils.VERTICES_PER_SPRITE;
        const tileCount = lightingData.length / 3;
        let bufferIndex = 0;
        for (let i = 0; i < tileCount; i++) {
            const r = lightingData[3 * i];
            const g = lightingData[3 * i + 1];
            const b = lightingData[3 * i + 2];
            for (let j = 0; j < verticesPerSprite; j++) {
                buffer[bufferIndex++] = r;
                buffer[bufferIndex++] = g;
                buffer[bufferIndex++] = b;
                buffer[bufferIndex++] = 1;
            }
        }
    }
    private updateColorMultBufferAtIndex(tileIndex: number, r: number, g: number, b: number, buffer: Float32Array): void {
        const verticesPerSprite = SpriteUtils.VERTICES_PER_SPRITE;
        let bufferIndex = tileIndex * verticesPerSprite * 4;
        for (let i = 0; i < verticesPerSprite; i++) {
            buffer[bufferIndex++] = r;
            buffer[bufferIndex++] = g;
            buffer[bufferIndex++] = b;
            buffer[bufferIndex++] = 1;
        }
    }
    dispose(): void {
        this.disposables.dispose();
    }
}
