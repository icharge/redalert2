import { LightingFx } from './LightingFx';
import { MapLighting } from '@/data/map/MapLighting';
import type { Anim } from '@/engine/renderable/entity/Anim';
export class LightningStormFx extends LightingFx {
    private durationGameSeconds: number;
    private ionLighting: MapLighting;
    private cloudAnims: Anim[];
    constructor(durationGameSeconds: number, ionLighting: MapLighting) {
        super();
        this.durationGameSeconds = durationGameSeconds;
        this.ionLighting = ionLighting;
        this.cloudAnims = [];
    }
    waitForCloudAnim(anim: Anim): void {
        this.cloudAnims.push(anim);
    }
    update(time: number, gameSpeed: number): {
        done: boolean;
        updated: boolean;
    } {
        let updated = false;
        let done = false;
        if (time === this.startTime) {
            this.mapLighting.copy(this.ionLighting);
            updated = true;
        }
        if (((time - this.startTime) / 1000) * gameSpeed > this.durationGameSeconds &&
            !this.cloudAnims.some(anim => !anim.isAnimFinished())) {
            done = true;
        }
        return { done, updated };
    }
}
