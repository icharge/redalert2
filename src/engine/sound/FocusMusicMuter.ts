import { ChannelType } from "./ChannelType";
import { StorageKey } from "../../LocalPrefs";
interface Mixer {
    setMuted(channel: ChannelType, muted: boolean): void;
}
interface LocalPrefs {
    getBool(key: StorageKey, defaultValue?: boolean): boolean;
}
// Mutes the music channel while the window is unfocused or the tab is hidden,
// so background music doesn't keep playing over whatever else has the user's
// attention. Re-reads the pref on every focus change instead of caching it,
// so a toggle in the sound options screen takes effect immediately.
export class FocusMusicMuter {
    private appliedMute = false;
    constructor(private readonly mixer: Mixer, private readonly localPrefs: LocalPrefs, private readonly win: Window = window, private readonly doc: Document = document) {
    }
    start(): void {
        this.win.addEventListener("blur", this.handleChange);
        this.win.addEventListener("focus", this.handleChange);
        this.doc.addEventListener("visibilitychange", this.handleChange);
        this.handleChange();
    }
    stop(): void {
        this.win.removeEventListener("blur", this.handleChange);
        this.win.removeEventListener("focus", this.handleChange);
        this.doc.removeEventListener("visibilitychange", this.handleChange);
        this.applyMute(false);
    }
    private handleChange = (): void => {
        const isUnfocused = this.doc.hidden || !this.doc.hasFocus();
        const enabled = this.localPrefs.getBool(StorageKey.MuteMusicOnBlur, false);
        this.applyMute(enabled && isUnfocused);
    };
    private applyMute(mute: boolean): void {
        if (this.appliedMute !== mute) {
            this.appliedMute = mute;
            this.mixer.setMuted(ChannelType.Music, mute);
        }
    }
}
