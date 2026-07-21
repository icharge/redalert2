import { Screen } from '../../Controller';
import { MainMenuScreenType } from '../../ScreenType';
import { MainMenuController } from '../MainMenuController';
import { Strings } from '../../../../data/Strings';
import { MessageBoxApi } from '../../../component/MessageBoxApi';
interface SidebarButton {
    label: string;
    tooltip?: string;
    disabled?: boolean;
    isBottom?: boolean;
    onClick: () => void | Promise<void>;
}
type TestEntryView = 'home' | 'asset' | 'mechanic' | 'scene';
export class TestEntryScreen implements Screen {
    private strings: Strings;
    private messageBoxApi: MessageBoxApi;
    private appVersion: string;
    private controller?: MainMenuController;
    private view: TestEntryView = 'home';
    public title: string = 'Test Entry';
    constructor(strings: Strings, messageBoxApi: MessageBoxApi, appVersion: string) {
        this.strings = strings;
        this.messageBoxApi = messageBoxApi;
        this.appVersion = appVersion;
    }
    setController(controller: MainMenuController): void {
        this.controller = controller;
    }
    onEnter(): void {
        console.log('[TestEntryScreen] Entering test entry screen');
        this.view = 'home';
        this.renderButtons();
        if (this.controller) {
            this.controller.toggleMainVideo(false);
            this.controller.showVersion(this.appVersion);
        }
    }
    private setView(view: TestEntryView): void {
        this.view = view;
        this.renderButtons();
    }
    private getSidebarTitle(): string {
        switch (this.view) {
            case 'asset':
                return 'Asset Tests';
            case 'mechanic':
                return 'Mechanic Tests';
            case 'scene':
                return 'Scene Tests';
            default:
                return this.title;
        }
    }
    private createRouteButton(label: string, tooltip: string, route: string): SidebarButton {
        return {
            label,
            tooltip,
            onClick: () => {
                console.log(`[TestEntryScreen] ${label} clicked`);
                window.location.hash = route;
            }
        };
    }
    private createBackToCategoriesButton(): SidebarButton {
        return {
            label: 'Back to Test Categories',
            onClick: () => this.setView('home')
        };
    }
    private createBackToMenuButton(): SidebarButton {
        return {
            label: 'Back to Main Menu',
            isBottom: true,
            onClick: () => {
                console.log('[TestEntryScreen] Back clicked');
                this.controller?.leaveCurrentScreen();
            }
        };
    }
    private renderButtons(): void {
        const homeButtons: SidebarButton[] = [
            {
                label: 'Asset Tests',
                tooltip: 'View VXL, SHP, and audio asset tests',
                onClick: () => this.setView('asset')
            },
            {
                label: 'Mechanic Tests',
                tooltip: 'View building, vehicle, infantry, and aircraft tests',
                onClick: () => this.setView('mechanic')
            },
            {
                label: 'Scene Tests',
                tooltip: 'View lobby, world, and movement tests',
                onClick: () => this.setView('scene')
            },
            this.createBackToMenuButton()
        ];
        const assetButtons: SidebarButton[] = [
            this.createRouteButton('VXL Test', 'Open the VXL test tool', '/vxltest'),
            this.createRouteButton('SHP Test', 'Open the SHP test tool', '/shptest'),
            this.createRouteButton('Audio Test', 'Open the audio test tool', '/soundtest'),
            this.createBackToCategoriesButton(),
            this.createBackToMenuButton()
        ];
        const mechanicButtons: SidebarButton[] = [
            this.createRouteButton('Building Test', 'Open the building test tool', '/buildtest'),
            this.createRouteButton('Vehicle Test', 'Open the vehicle test tool', '/vehicletest'),
            this.createRouteButton('Infantry Test', 'Open the infantry test tool', '/inftest'),
            this.createRouteButton('Aircraft Test', 'Open the aircraft test tool', '/airtest'),
            this.createBackToCategoriesButton(),
            this.createBackToMenuButton()
        ];
        const sceneButtons: SidebarButton[] = [
            this.createRouteButton('Lobby Test', 'Open the lobby test tool', '/lobbytest'),
            this.createRouteButton('World Test', 'Open the world scene test tool', '/worldscenetest'),
            this.createRouteButton('Movement Test', 'Open the unit movement test tool', '/unitmovementtest'),
            this.createRouteButton('Scene Sandbox', 'Open the map sandbox where units can be placed manually', '/scenesandbox'),
            this.createRouteButton('Performance Test', 'Open the performance benchmark test tool', '/perftest'),
            this.createBackToCategoriesButton(),
            this.createBackToMenuButton()
        ];
        const buttons = this.view === 'asset'
            ? assetButtons
            : this.view === 'mechanic'
                ? mechanicButtons
                : this.view === 'scene'
                    ? sceneButtons
                    : homeButtons;
        if (this.controller) {
            this.controller.setSidebarTitle(this.getSidebarTitle());
            this.controller.setSidebarButtons(buttons);
            this.controller.showSidebarButtons();
        }
    }
    async onLeave(): Promise<void> {
        console.log('[TestEntryScreen] Leaving test entry screen');
        if (this.controller) {
            await this.controller.hideSidebarButtons();
            this.controller.setSidebarTitle('');
            this.controller.hideVersion();
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
}
