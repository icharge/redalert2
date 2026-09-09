import { IndexedBitmap } from "../../../data/Bitmap";
import { TextureAtlas } from "../../gfx/TextureAtlas";
import type { ShpFile } from "../../../data/ShpFile";
import * as THREE from 'three';
interface TextureArea {
    x: number;
    y: number;
    width: number;
    height: number;
}
export class ShpTextureAtlas {
    private images: IndexedBitmap[];
    private atlas: TextureAtlas;
    fromShpFile(shpFile: ShpFile): ShpTextureAtlas {
        const bitmaps: IndexedBitmap[] = [];
        for (let i = 0; i < shpFile.numImages; i++) {
            const image = shpFile.getImage(i);
            bitmaps.push(new IndexedBitmap(image.width, image.height, image.imageData));
        }
        const atlas = new TextureAtlas();
        atlas.pack(bitmaps);
        this.images = bitmaps;
        this.atlas = atlas;
        return this;
    }
    getTextureArea(imageIndex: number): TextureArea {
        return this.atlas.getImageRect(this.images[imageIndex]);
    }
    getTexture(): THREE.Texture {
        return this.atlas.getTexture();
    }
    dispose(): void {
        this.atlas.dispose();
    }
}
