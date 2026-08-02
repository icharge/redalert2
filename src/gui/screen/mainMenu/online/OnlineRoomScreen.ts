import { MainMenuScreen } from '@/gui/screen/mainMenu/MainMenuScreen';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { jsx } from '@/gui/jsx/jsx';
import { OnlineRoom } from '@/gui/screen/mainMenu/online/component/OnlineRoom';
import { MusicType } from '@/engine/sound/Music';
import { LanMatchSession } from '@/network/lan/LanMatchSession';
import { LanMeshSession } from '@/network/lan/LanMeshSession';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { LanRoomSession } from '@/network/lan/LanRoomSession';
import { PregameController, PregameMapSelectionResult } from '@/gui/screen/mainMenu/lobby/PregameController';
import { MainMenuScreenType, ScreenType } from '@/gui/screen/ScreenType';
import { LobbyType } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { MapPreviewRenderer } from '@/gui/screen/mainMenu/lobby/MapPreviewRenderer';
import { MapFile } from '@/data/MapFile';
import { MainMenuRoute } from '@/gui/screen/mainMenu/MainMenuRoute';
import { uint8ArrayToBase64String } from '@/util/string';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';

interface RootController {
    goToScreen(screenType: number, params?: any): void;
}

interface GameMode {
    id: number;
    label: string;
    mpDialogSettings: any;
}

interface GameModes {
    getAll(): GameMode[];
    getById(id: number): GameMode;
}

interface MapFileLoader {
    load(mapName: string): Promise<any>;
}

interface MessageBoxApi {
    show(message: any, buttons?: any, callback?: any): void;
}

export interface OnlineRoomScreenParams {
    meshSession: LanMeshSession;
    roomSession: LanRoomSession;
    onlineSession: OnlineRoomSession;
    pregameController: PregameController;
    chatHistory: ChatHistory;
}

export class OnlineRoomScreen extends MainMenuScreen {
    declare public title: string;
    declare public musicType: MusicType;

    private form?: any;
    private previewRequestId = 0;
    private activeMatchSession?: LanMatchSession;

    private meshSession!: LanMeshSession;
    private roomSession!: LanRoomSession;
    private onlineSession!: OnlineRoomSession;
    private pregameController!: PregameController;
    private chatHistory!: ChatHistory;

    constructor(
        private readonly rootController: RootController,
        private readonly strings: any,
        private readonly jsxRenderer: any,
        private readonly mapFileLoader: MapFileLoader,
        private readonly gameModes: GameModes,
        private readonly messageBoxApi: MessageBoxApi
    ) {
        super();
        this.title = '';
        this.musicType = MusicType.Intro;
    }

    onEnter(params: OnlineRoomScreenParams): void {
        this.meshSession = params.meshSession;
        this.roomSession = params.roomSession;
        this.onlineSession = params.onlineSession;
        this.pregameController = params.pregameController;
        this.chatHistory = params.chatHistory;

        this.controller.toggleMainVideo(false);
        this.initView();
        this.subscribeRoomEvents();
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        void this.refreshSidebarPreview();
        this.controller.showSidebarButtons();
    }

    async onLeave(): Promise<void> {
        this.previewRequestId += 1;
        this.unsubscribeRoomEvents();
        await this.controller.hideSidebarButtons();
        this.form = undefined;
    }

    async onStack(): Promise<void> {
        await this.onLeave();
    }

    onUnstack(params?: PregameMapSelectionResult): void {
        this.subscribeRoomEvents();
        if (params) {
            this.pregameController.applyMapSelection(params);
            this.pregameController.updateSelfName(this.meshSession.getSelf().name);
            const roomSnapshot = this.roomSession.getSnapshot();
            if (roomSnapshot.isHost && roomSnapshot.roomState) {
                this.roomSession.applyHostPregameSnapshot(this.pregameController.getSnapshot());
            }
        }
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        void this.refreshSidebarPreview();
        this.refreshView();
        this.controller.showSidebarButtons();
    }

    private handleMeshSnapshot = () => {
        this.refreshSidebarButtons();
    };

    private handleRoomSnapshot = () => {
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        void this.refreshSidebarPreview();
    };

    private handleOnlineDisconnected = () => {
        void this.handleLeaveRoom();
    };

    private handleKicked = (entry: { reason: string }) => {
        void this.handleLeaveRoom();
        this.messageBoxApi.show(`You were removed from the room by the host (${entry.reason}).`, 'OK');
    };

    private handleLockChanged = () => {
        this.refreshSidebarButtons();
        this.refreshView();
    };

    private handleLaunch = (descriptor: any) => {
        this.activeMatchSession?.dispose();
        this.activeMatchSession = new LanMatchSession(this.meshSession, descriptor);
        this.onlineSession.notifyGameStarted();
        this.rootController.goToScreen(ScreenType.Game, {
            create: true,
            lanLaunch: descriptor,
            lanMatchSession: this.activeMatchSession,
            lanMapDataBase64: this.roomSession.getResolvedCustomMapFile()
                ? uint8ArrayToBase64String(this.roomSession.getResolvedCustomMapFile()!.getBytes())
                : undefined,
            returnTo: new MainMenuRoute(MainMenuScreenType.OnlineSetup, {}),
        });
    };

    private subscribeRoomEvents(): void {
        this.unsubscribeRoomEvents();
        this.roomSession.onSnapshotChange.subscribe(this.handleRoomSnapshot);
        this.meshSession.onSnapshotChange.subscribe(this.handleMeshSnapshot);
        this.roomSession.onLaunch.subscribe(this.handleLaunch);
        this.roomSession.onKicked.subscribe(this.handleKicked);
        this.onlineSession.onDisconnected.subscribe(this.handleOnlineDisconnected);
        this.onlineSession.onLockChanged.subscribe(this.handleLockChanged);
    }

    private unsubscribeRoomEvents(): void {
        this.roomSession.onSnapshotChange.unsubscribe(this.handleRoomSnapshot);
        this.meshSession.onSnapshotChange.unsubscribe(this.handleMeshSnapshot);
        this.roomSession.onLaunch.unsubscribe(this.handleLaunch);
        this.roomSession.onKicked.unsubscribe(this.handleKicked);
        this.onlineSession.onDisconnected.unsubscribe(this.handleOnlineDisconnected);
        this.onlineSession.onLockChanged.unsubscribe(this.handleLockChanged);
    }

    private initView(): void {
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            innerRef: (ref: any) => (this.form = ref),
            component: OnlineRoom,
            props: this.buildComponentProps(),
        }));
        this.controller.setMainComponent(component);
    }

    private refreshView(): void {
        if (!this.form) {
            this.initView();
            return;
        }
        this.form.applyOptions((options: any) => {
            Object.assign(options, this.buildComponentProps());
        });
    }

    private buildComponentProps(): any {
        return {
            meshSession: this.meshSession,
            roomSession: this.roomSession,
            onlineSession: this.onlineSession,
            pregameController: this.pregameController,
            chatHistory: this.chatHistory,
            locked: this.onlineSession.isLocked(),
            onHostPregameChanged: () => {
                this.roomSession.applyHostPregameSnapshot(this.pregameController.getSnapshot());
                this.refreshSidebarMpText();
                void this.refreshSidebarPreview();
            },
            onTransferHost: (slotIndex: number) => this.handleTransferHost(slotIndex),
        };
    }

    private handleTransferHost(slotIndex: number): void {
        const roomSnapshot = this.roomSession.getSnapshot();
        if (!roomSnapshot.isHost) {
            return;
        }
        const targetPeerId = roomSnapshot.roomState?.humanAssignments.find((assignment) => assignment.slotIndex === slotIndex)?.peerId;
        if (!targetPeerId) {
            return;
        }
        this.roomSession.transferHost(targetPeerId);
        this.onlineSession.transferHost(targetPeerId);
    }

    private async handleChangeMap(): Promise<void> {
        if (!this.roomSession.getSnapshot().isHost || !this.roomSession.getSnapshot().roomState) {
            return;
        }
        await this.controller.pushScreen(MainMenuScreenType.MapSelection, {
            lobbyType: LobbyType.MultiplayerHost,
            gameOpts: this.pregameController.getGameOpts(),
            usedSlots: () => this.pregameController.getUsedSlots(),
        });
    }

    private async handleLeaveRoom(): Promise<void> {
        // autoMigrateHost: false — a host leaving Online Play closes the
        // room outright (server broadcasts 'host-lost') unless they already
        // used transferHost(), so we don't want the usual LAN-style
        // automatic mesh handover here.
        this.roomSession.leaveRoom({ autoMigrateHost: false });
        this.onlineSession.leaveRoom();
        // leaveRoom() (not reset()) so remaining peers get a graceful
        // member-leave signal instead of their direct link just dying —
        // otherwise it looks identical to an involuntary disconnect and
        // triggers the reconnect grace period/"Reconnecting..." state for
        // someone who isn't coming back.
        if (this.meshSession.getSnapshot().isInRoom) {
            this.meshSession.leaveRoom();
        }
        else {
            this.meshSession.reset();
        }
        this.chatHistory.reset();
        this.controller.setSidebarPreview();
        this.controller.setSidebarMpContent({ text: '' });
        await this.controller.popScreen();
    }

    private async startOnlineGame(): Promise<void> {
        const roomSnapshot = this.roomSession.getSnapshot();
        if (!roomSnapshot.isHost) {
            return;
        }
        if (!roomSnapshot.canStart) {
            this.messageBoxApi.show('Some members have not finished connecting, syncing the map, or are not ready.', 'OK');
            return;
        }
        this.roomSession.startGameCountdown({
            screenType: MainMenuScreenType.OnlineSetup,
            params: {},
        });
    }

    private refreshSidebarButtons(): void {
        const roomSnapshot = this.roomSession.getSnapshot();
        const selfMember = roomSnapshot.members.find((member) => member.isSelf);
        const buttons: any[] = [];

        buttons.push({
            label: roomSnapshot.countdown ? 'Cancel Start' : 'Start Game',
            tooltip: roomSnapshot.isHost
                ? roomSnapshot.countdown
                    ? 'Cancel the countdown'
                    : roomSnapshot.canStart
                        ? 'Start a countdown before launching'
                        : 'Wait for connection, map sync, and everyone to be ready'
                : 'Only the host can start the game',
            disabled: !roomSnapshot.isHost || (!roomSnapshot.canStart && !roomSnapshot.countdown),
            onClick: () => {
                if (roomSnapshot.countdown) {
                    this.roomSession.cancelCountdown('Host cancelled');
                    return;
                }
                void this.startOnlineGame();
            },
        });

        if (roomSnapshot.isRoomActive && roomSnapshot.isHost) {
            buttons.push({
                label: 'Change Map',
                tooltip: 'Reselect mode and map',
                onClick: () => {
                    void this.handleChangeMap();
                },
            });
        }
        else if (roomSnapshot.isRoomActive && selfMember) {
            buttons.push({
                label: selfMember.ready ? 'Unready' : 'Ready',
                tooltip: 'Toggle your ready status',
                onClick: () => {
                    void this.roomSession.setReady(!selfMember.ready);
                },
            });
        }

        if (roomSnapshot.isRoomActive && roomSnapshot.isHost) {
            const locked = this.onlineSession.isLocked();
            buttons.push({
                label: locked ? 'Unlock Room' : 'Lock Room',
                tooltip: locked
                    ? 'Allow other players to join this room again'
                    : 'Prevent other players from joining this room',
                onClick: () => {
                    this.onlineSession.setLocked(!locked);
                },
            });
        }

        buttons.push({
            label: 'Leave Room',
            tooltip: 'Leave the current online room and return to the entry page',
            isBottom: true,
            onClick: () => {
                void this.handleLeaveRoom();
            },
        });

        this.controller.setSidebarButtons(buttons, true);
    }

    private refreshSidebarMpText(): void {
        const roomSnapshot = this.roomSession.getSnapshot();
        if (roomSnapshot.roomState) {
            const gameOpts = roomSnapshot.roomState.gameOpts;
            this.controller.setSidebarMpContent({
                text: this.strings.get(this.gameModes.getById(gameOpts.gameMode).label) + '\n\n' + gameOpts.mapTitle,
                icon: gameOpts.mapOfficial ? 'gt18.pcx' : 'settings.png',
                tooltip: gameOpts.mapOfficial ? 'This room uses an official map' : 'This room uses a custom map',
            });
            return;
        }
        this.controller.setSidebarMpContent({
            text: '',
        });
    }

    private async refreshSidebarPreview(): Promise<void> {
        const roomSnapshot = this.roomSession.getSnapshot();
        const roomState = roomSnapshot.roomState;
        if (!roomState) {
            this.controller.toggleSidebarPreview(false);
            this.controller.setSidebarPreview();
            return;
        }

        const requestId = ++this.previewRequestId;
        try {
            let mapFile = this.roomSession.getResolvedCustomMapFile() ?? this.pregameController.getCurrentMapFile();
            if (!mapFile) {
                mapFile = await this.mapFileLoader.load(roomState.gameOpts.mapName);
            }
            if (requestId !== this.previewRequestId) {
                return;
            }
            const preview = new MapPreviewRenderer(this.strings).render(
                new MapFile(mapFile),
                roomSnapshot.isHost ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
                this.controller.getSidebarPreviewSize()
            );
            this.controller.toggleSidebarPreview(true);
            this.controller.setSidebarPreview(preview);
        }
        catch (error) {
            if (requestId !== this.previewRequestId) {
                return;
            }
            console.warn('[OnlineRoomScreen] Failed to refresh sidebar preview', error);
            this.controller.setSidebarPreview();
        }
    }
}
