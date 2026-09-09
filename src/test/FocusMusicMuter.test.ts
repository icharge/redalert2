import { describe, test, expect } from 'bun:test';
import { FocusMusicMuter } from '@/engine/sound/FocusMusicMuter';
import { ChannelType } from '@/engine/sound/ChannelType';
import { StorageKey } from '@/LocalPrefs';

class FakeMixer {
    muted = new Map<ChannelType, boolean>();
    setMuted(channel: ChannelType, muted: boolean): void {
        this.muted.set(channel, muted);
    }
}
class FakeLocalPrefs {
    constructor(private enabled: boolean) {
    }
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }
    getBool(_key: StorageKey, _defaultValue?: boolean): boolean {
        return this.enabled;
    }
}
class FakeDocument extends EventTarget {
    hidden = false;
    private focused = true;
    hasFocus(): boolean {
        return this.focused;
    }
    setFocused(focused: boolean): void {
        this.focused = focused;
    }
}
function setup(enabled: boolean) {
    const mixer = new FakeMixer();
    const localPrefs = new FakeLocalPrefs(enabled);
    const doc = new FakeDocument();
    const win = new EventTarget();
    const muter = new FocusMusicMuter(mixer as any, localPrefs as any, win as any, doc as any);
    return { mixer, localPrefs, doc, win, muter };
}
describe('FocusMusicMuter', () => {
    test('mutes music on window blur and unmutes on refocus', () => {
        const { mixer, doc, win, muter } = setup(true);
        muter.start();

        doc.setFocused(false);
        win.dispatchEvent(new Event('blur'));
        expect(mixer.muted.get(ChannelType.Music)).toBe(true);

        doc.setFocused(true);
        win.dispatchEvent(new Event('focus'));
        expect(mixer.muted.get(ChannelType.Music)).toBe(false);
    });
    test('mutes music when the tab is hidden and unmutes when visible again', () => {
        const { mixer, doc, muter } = setup(true);
        muter.start();

        doc.hidden = true;
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(mixer.muted.get(ChannelType.Music)).toBe(true);

        doc.hidden = false;
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(mixer.muted.get(ChannelType.Music)).toBe(false);
    });
    test('leaves music unmuted when the preference is disabled', () => {
        const { mixer, doc, win, muter } = setup(false);
        muter.start();

        doc.setFocused(false);
        win.dispatchEvent(new Event('blur'));
        expect(mixer.muted.get(ChannelType.Music)).toBeFalsy();
    });
    test('picks up a preference change made while already unfocused', () => {
        const { mixer, localPrefs, doc, win, muter } = setup(false);
        muter.start();
        doc.setFocused(false);
        win.dispatchEvent(new Event('blur'));
        expect(mixer.muted.get(ChannelType.Music)).toBeFalsy();

        localPrefs.setEnabled(true);
        win.dispatchEvent(new Event('blur'));
        expect(mixer.muted.get(ChannelType.Music)).toBe(true);
    });
    test('stop() unmutes and detaches listeners', () => {
        const { mixer, doc, win, muter } = setup(true);
        muter.start();
        doc.setFocused(false);
        win.dispatchEvent(new Event('blur'));
        expect(mixer.muted.get(ChannelType.Music)).toBe(true);

        muter.stop();
        expect(mixer.muted.get(ChannelType.Music)).toBe(false);

        mixer.muted.clear();
        win.dispatchEvent(new Event('focus'));
        expect(mixer.muted.has(ChannelType.Music)).toBe(false);
    });
});
