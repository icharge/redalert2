import { describe, test, expect } from 'bun:test';
import * as THREE from 'three';
import { MapTileLayer } from '@/engine/renderable/entity/map/MapTileLayer';
import { SpriteUtils } from '@/engine/gfx/SpriteUtils';

// repaintTile() only touches tileIndexes/textureAtlas/uvAttribute/
// tileDrawableMap - build a MapTileLayer with just those set, skipping the
// full WebGL createTileObjects() pipeline (theater/palette/material/etc),
// exactly the way this method needs to work when called on a layer that
// already went through that pipeline for real.
function makeLayer(tileIndexes: Map<any, number>, textureAtlas: any, floatsPerTile: number): { layer: MapTileLayer; uvArray: Float32Array } {
    const layer = Object.create(MapTileLayer.prototype) as MapTileLayer;
    const uvArray = new Float32Array(floatsPerTile * tileIndexes.size).fill(-1);
    (layer as any).tileIndexes = tileIndexes;
    (layer as any).tileDrawableMap = new Map();
    (layer as any).textureAtlas = textureAtlas;
    (layer as any).uvAttribute = new THREE.BufferAttribute(uvArray, 2);
    return { layer, uvArray };
}

function makeTextureAtlas(rectsByDrawable: Map<any, { x: number; y: number; width: number; height: number }>, imageSize: { width: number; height: number }) {
    return {
        getImageRect: (drawable: any) => {
            const rect = rectsByDrawable.get(drawable);
            if (!rect) {
                throw new Error('Image not found in atlas');
            }
            return rect;
        },
        getTexture: () => ({ image: imageSize }),
    };
}

const FLOATS_PER_TILE = 16; // 8 vertices * 2 uv components

describe('MapTileLayer.repaintTile', () => {
    test('writes the expected UVs for both half-rects and marks the buffer dirty for GPU re-upload', () => {
        const tile = { rx: 5, ry: 7 };
        const drawable = { id: 'new-art' };
        const imageSize = { width: 256, height: 128 };
        const rect = { x: 40, y: 10, width: 20, height: 8 };
        const atlas = makeTextureAtlas(new Map([[drawable, rect]]), imageSize);
        const { layer, uvArray } = makeLayer(new Map([[tile, 0]]), atlas, FLOATS_PER_TILE);
        const versionBefore = (layer as any).uvAttribute.version;

        const result = layer.repaintTile(tile, drawable);

        expect(result).toBe(true);
        // BufferAttribute.needsUpdate is a write-only setter (Three.js) that
        // bumps .version - there's no readable needsUpdate getter to assert
        // on directly, so check the effect that setter has instead.
        expect((layer as any).uvAttribute.version).toBeGreaterThan(versionBefore);
        expect((layer as any).tileDrawableMap.get(tile)).toBe(drawable);

        const expected = new Float32Array(FLOATS_PER_TILE);
        const splitWidth = rect.width / 2;
        SpriteUtils.writeIndexedRectUvsIntoBuffer(expected, 0, { x: rect.x, y: rect.y, width: splitWidth, height: rect.height }, imageSize);
        SpriteUtils.writeIndexedRectUvsIntoBuffer(expected, 1, { x: rect.x + splitWidth, y: rect.y, width: rect.width - splitWidth, height: rect.height }, imageSize);
        expect(uvArray).toEqual(expected);
    });

    test('only touches the target tile\'s vertices, leaving other tiles\' UVs untouched', () => {
        const tile0 = { rx: 0, ry: 0 };
        const tile1 = { rx: 1, ry: 0 };
        const drawable = { id: 'art' };
        const imageSize = { width: 64, height: 64 };
        const rect = { x: 0, y: 0, width: 16, height: 16 };
        const atlas = makeTextureAtlas(new Map([[drawable, rect]]), imageSize);
        const { layer, uvArray } = makeLayer(new Map([[tile0, 0], [tile1, 1]]), atlas, FLOATS_PER_TILE);

        layer.repaintTile(tile1, drawable);

        // tile0's 16 floats (untouched sentinel value) must be unaffected.
        expect(Array.from(uvArray.slice(0, FLOATS_PER_TILE))).toEqual(new Array(FLOATS_PER_TILE).fill(-1));
        // tile1's floats were actually written (no longer the sentinel).
        expect(Array.from(uvArray.slice(FLOATS_PER_TILE))).not.toEqual(new Array(FLOATS_PER_TILE).fill(-1));
    });

    test('returns false and leaves the buffer untouched when the drawable is not in the atlas (Tier 2 case)', () => {
        const tile = { rx: 0, ry: 0 };
        const atlas = makeTextureAtlas(new Map(), { width: 64, height: 64 });
        const { layer, uvArray } = makeLayer(new Map([[tile, 0]]), atlas, FLOATS_PER_TILE);
        const before = uvArray.slice();

        const result = layer.repaintTile(tile, { id: 'not-packed' });

        expect(result).toBe(false);
        expect(uvArray).toEqual(before);
        expect((layer as any).tileDrawableMap.has(tile)).toBe(false);
    });

    test('returns false for a tile this layer does not know about', () => {
        const knownTile = { rx: 0, ry: 0 };
        const atlas = makeTextureAtlas(new Map(), { width: 64, height: 64 });
        const { layer } = makeLayer(new Map([[knownTile, 0]]), atlas, FLOATS_PER_TILE);

        const result = layer.repaintTile({ rx: 99, ry: 99 }, { id: 'x' });

        expect(result).toBe(false);
    });
});
