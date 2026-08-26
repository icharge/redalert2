import { ChannelType } from "./ChannelType";
import type { AudioFile } from "./AudioSystem";
interface EvaSpec {
    sound: string;
    priority: number;
    queue?: boolean;
}
interface EvaSpecs {
    getSpec(name: string): EvaSpec | undefined;
}
interface PlaybackHandle {
    isPlaying(): boolean;
    stop(): void;
}
interface Sound {
    getWavFile(name: string): AudioFile | undefined;
    audioSystem: {
        playWavFile(file: AudioFile, channel: ChannelType): PlaybackHandle;
    };
}
interface Renderer {
    onFrame: {
        subscribe(handler: (time: number) => void): void;
        unsubscribe(handler: (time: number) => void): void;
    };
}
export class Eva {
    private evaSpecs: EvaSpecs;
    private sound: Sound;
    private renderer: Renderer;
    private evaWaitingList: EvaSpec[] = [];
    private lastEvaEventByName = new Map<string, number>();
    private currentEvaPlaying?: PlaybackHandle;
    constructor(evaSpecs: EvaSpecs, sound: Sound, renderer: Renderer) {
        this.evaSpecs = evaSpecs;
        this.sound = sound;
        this.renderer = renderer;
    }
    private handleFrame = (time: number): void => {
        if (this.currentEvaPlaying?.isPlaying()) {
            return;
        }
        this.currentEvaPlaying = undefined;
        this.evaWaitingList.sort((a, b) => b.priority - a.priority);
        this.evaWaitingList = this.evaWaitingList.filter((eva) => time - (this.lastEvaEventByName.get(eva.sound) || 0) >= 5000);
        while (this.evaWaitingList.length) {
            const nextEva = this.evaWaitingList.shift()!;
            const wavFile = this.sound.getWavFile(nextEva.sound);
            if (!wavFile) {
                continue;
            }
            this.currentEvaPlaying = this.sound.audioSystem.playWavFile(wavFile, ChannelType.Voice);
            this.lastEvaEventByName.set(nextEva.sound, time);
            break;
        }
    };
    init(): void {
        this.renderer.onFrame.subscribe(this.handleFrame);
    }
    dispose(): void {
        this.renderer.onFrame.unsubscribe(this.handleFrame);
        this.currentEvaPlaying?.stop();
    }
    play(name: string, _queue: boolean = false): void {
        const spec = this.evaSpecs.getSpec(name);
        if (spec) {
            this.evaWaitingList.push(spec);
        }
        else {
            console.warn(`No EVA with name ${name} was found. Skipping.`);
        }
    }
}
