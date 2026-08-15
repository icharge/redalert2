import { MusicType } from "@/engine/sound/Music";

export class MainMenuScreen {
    protected controller: any;
    protected title?: string;
    protected musicType?: MusicType;
    setController(controller: any): void {
        this.controller = controller;
    }
}
