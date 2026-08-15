import { Screen } from '../../Controller';
import { MainMenuScreenType } from '../../ScreenType';
import { MainMenuController } from '../MainMenuController';
import { Strings } from '../../../../data/Strings';
import { MusicType } from '../../../../engine/sound/Music';
import { MessageBoxApi } from '../../../component/MessageBoxApi';
import { FullScreen } from '../../../FullScreen';
import { getHumanReadableKey } from '@/gui/screen/options/component/getHumanReadableKey';
import { MainMenuRoute } from '../MainMenuRoute';
interface SidebarButton {
    label: string;
    tooltip?: string;
    disabled?: boolean;
    isBottom?: boolean;
    onClick: () => void | Promise<void>;
}
export class HomeScreen implements Screen {
    private strings: Strings;
    private messageBoxApi: MessageBoxApi;
    private appVersion: string;
    private storageEnabled: boolean;
    private quickMatchEnabled: boolean;
    private fullScreen?: FullScreen;
    private controller?: MainMenuController;
    public title: string;
    public musicType: MusicType;
    constructor(strings: Strings, messageBoxApi: MessageBoxApi, appVersion: string, storageEnabled: boolean = false, quickMatchEnabled: boolean = false, fullScreen?: FullScreen) {
        this.strings = strings;
        this.messageBoxApi = messageBoxApi;
        this.appVersion = appVersion;
        this.storageEnabled = storageEnabled;
        this.quickMatchEnabled = quickMatchEnabled;
        this.fullScreen = fullScreen;
        this.title = this.strings.get("GUI:MainMenu") || "Main Menu";
        this.musicType = MusicType.Intro;
    }
    setController(controller: MainMenuController): void {
        this.controller = controller;
    }
    onEnter(): void {
        console.log('[HomeScreen] Entering home screen');
        const buttons: SidebarButton[] = [];
        if (this.quickMatchEnabled) {
            buttons.push({
                label: this.strings.get('GUI:QuickMatch') || 'Quick Match',
                tooltip: this.strings.get('STT:MainButtonQuickMatch') || 'Join an online quick match',
                onClick: () => {
                    console.log('[HomeScreen] Quick Match clicked');
                    if (this.controller) {
                        this.controller.goToScreen(MainMenuScreenType.Login, {
                            afterLogin: (messages: any[]) => new MainMenuRoute(MainMenuScreenType.QuickGame, { messages }),
                        });
                    }
                }
            });
        }
        buttons.push({
            label: this.strings.get('GUI:CustomGame') || 'Custom Game',
            tooltip: this.strings.get('STT:MainButtonCustomGame') || 'Browse online custom games',
            onClick: () => {
                console.log('[HomeScreen] Custom Game clicked');
                if (this.controller) {
                    this.controller.goToScreen(MainMenuScreenType.Login, {
                        afterLogin: (messages: any[]) => new MainMenuRoute(MainMenuScreenType.CustomGame, { messages }),
                    });
                }
            }
        }, {
            label: 'Skirmish',
            tooltip: 'Single-player skirmish against AI',
            onClick: async () => {
                console.log('[HomeScreen] Skirmish clicked');
                try {
                    if (this.controller) {
                        this.controller.goToScreen(MainMenuScreenType.Skirmish);
                    }
                }
                catch (error) {
                    console.error('[HomeScreen] Failed to navigate to Skirmish:', error);
                    await this.messageBoxApi.alert('Skirmish - Feature Under Development\n\nThe basic framework is configured, but the following components still need to be completed:\n• Game rules system\n• Map loader\n• AI opponent system\n• Game mode manager', this.strings.get('GUI:OK') || 'OK');
                }
            }
        }, ...(import.meta.env.DEV ? [{
            label: 'Live Interaction',
            tooltip: 'Enter live interaction mode: respond to join, like, and gift events to drive both sides into battle',
            onClick: () => {
                console.log('[HomeScreen] Live Interaction clicked');
                window.location.hash = '/liveinteraction';
            }
        }] : []),
            {
                label: 'Replays',
                tooltip: 'View and replay game recordings',
                onClick: () => {
                    console.log('[HomeScreen] Replays clicked');
                    if (this.controller) {
                        this.controller.pushScreen(MainMenuScreenType.ReplaySelection);
                    }
                }
            },
            {
                label: 'LAN Multiplayer',
                tooltip: 'Manually exchange SDP to establish a LAN P2P data channel',
                onClick: () => {
                    console.log('[HomeScreen] LAN Setup clicked');
                    if (this.controller) {
                        this.controller.pushScreen(MainMenuScreenType.LanSetup);
                    }
                }
            },
        );
        if (this.storageEnabled) {
            buttons.push({
                label: this.strings.get('GUI:Mods') || 'Mods',
                tooltip: this.strings.get('STT:Mods') || 'Manage and play modified versions of the base game',
                onClick: async () => {
                    console.log('[HomeScreen] Mods clicked');
                    await this.messageBoxApi.alert('Mods - Feature Under Development\n\nA mod management system is required', this.strings.get('GUI:OK') || 'OK');
                }
            });
        }
        buttons.push({
            label: this.strings.get('TS:InfoAndCredits') || 'Info & Credits',
            tooltip: this.strings.get('STT:InfoAndCredits') || 'Information and credits',
            onClick: () => {
                console.log('[HomeScreen] Info & Credits clicked');
                if (this.controller) {
                    this.controller.pushScreen(MainMenuScreenType.InfoAndCredits);
                }
            }
        }, {
            label: this.strings.get('GUI:Options') || 'Options',
            tooltip: this.strings.get('STT:MainButtonOptions') || 'Game options and settings',
            onClick: () => {
                console.log('[HomeScreen] Options clicked');
                if (this.controller) {
                    this.controller.pushScreen(MainMenuScreenType.Options);
                }
            }
        }, ...(import.meta.env.DEV ? [{
            label: 'Test Entry',
            tooltip: 'Enter low-level file system and test tools',
            onClick: () => {
                console.log('[HomeScreen] Test Entry clicked');
                if (this.controller) {
                    this.controller.pushScreen(MainMenuScreenType.TestEntry);
                }
            }
        }] : []), {
            label: this.strings.get('GUI:Fullscreen', getHumanReadableKey(FullScreen.hotKey)) || 'Fullscreen',
            tooltip: this.strings.get('STT:Fullscreen') || 'Toggle full screen mode',
            isBottom: true,
            disabled: this.fullScreen ? !this.fullScreen.isAvailable() : false,
            onClick: () => {
                console.log('[HomeScreen] Fullscreen clicked');
                this.toggleFullscreen();
            }
        });
        if (this.controller) {
            this.controller.setSidebarButtons(buttons);
            this.controller.showSidebarButtons();
            this.controller.toggleMainVideo(true);
            this.controller.showVersion(this.appVersion);
        }
    }
    async onLeave(): Promise<void> {
        console.log('[HomeScreen] Leaving home screen');
        if (this.controller) {
            this.controller.hideVersion();
            await this.controller.hideSidebarButtons();
        }
    }
    async onStack(): Promise<void> {
        await this.onLeave();
    }
    onUnstack(): void {
        this.onEnter();
    }
    update(deltaTime: number): void {
    }
    destroy(): void {
    }
    private async toggleFullscreen(): Promise<void> {
        try {
            if (this.fullScreen?.isAvailable()) {
                await this.fullScreen.toggleAsync();
            }
            else if (document.fullscreenElement) {
                await document.exitFullscreen();
            }
            else {
                await document.documentElement.requestFullscreen();
            }
        }
        catch (err) {
            console.error('Error toggling fullscreen:', err);
            await this.messageBoxApi.alert(document.fullscreenElement
                ? 'Unable to exit fullscreen mode'
                : 'Unable to enter fullscreen mode\n\nPlease check browser permission settings', this.strings.get('GUI:OK') || 'OK');
        }
    }
}
