import { MainMenuScreen } from '@/gui/screen/mainMenu/MainMenuScreen';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { jsx } from '@/gui/jsx/jsx';
import { OnlineSetup } from '@/gui/screen/mainMenu/online/component/OnlineSetup';
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
import { StorageKey } from '@/LocalPrefs';
import { uint8ArrayToBase64String } from '@/util/string';
import { SlotType as NetSlotType } from '@/network/gameopt/SlotInfo';
import { OBS_COUNTRY_ID } from '@/game/gameopts/constants';
import { ColyseusClient } from '@/network/colyseus/ColyseusClient';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';

interface RootController {
    goToScreen(screenType: number, params?: any): void;
}

interface Rules {
    getMultiplayerCountries(): any[];
    getMultiplayerColors(): Map<number, any>;
    mpDialogSettings: any;
    general?: any;
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

interface MapListEntry {
    fileName: string;
    maxSlots: number;
    getFullMapTitle(strings: any): string;
}

interface MapList {
    getAll(): MapListEntry[];
    getByName(name: string): MapListEntry;
    addFromMapFile(file: any): void;
}

interface MapFileLoader {
    load(mapName: string): Promise<any>;
}

interface LocalPrefs {
    getItem(key: string): string | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

interface MessageBoxApi {
    show(message: string, buttonText?: string, onClose?: () => void): void;
}

interface MapDirectory {
    containsEntry(entryName: string): Promise<boolean>;
    writeFile(file: any): Promise<void>;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export class OnlineSetupScreen extends MainMenuScreen {
    declare public title: string;
    declare public musicType: MusicType;

    private form?: any;
    private resetNonce = 0;
    private createRoomRequestId = 0;
    private previewRequestId = 0;
    private busy = false;

    private readonly meshSession = new LanMeshSession(DEFAULT_ICE_SERVERS);
    private readonly chatHistory = new ChatHistory();
    private readonly roomSession: LanRoomSession;
    private readonly colyseusClient: ColyseusClient;
    private readonly onlineSession: OnlineRoomSession;
    private pregameController: PregameController;
    private activeMatchSession?: LanMatchSession;

    constructor(
        private readonly rootController: RootController,
        private readonly strings: any,
        private readonly jsxRenderer: any,
        private readonly rules: Rules,
        private readonly mapFileLoader: MapFileLoader,
        private readonly mapList: MapList,
        private readonly gameModes: GameModes,
        private readonly localPrefs: LocalPrefs,
        private readonly messageBoxApi: MessageBoxApi,
        private readonly colyseusUrl: string,
        private readonly mapDir?: MapDirectory
    ) {
        super();
        this.title = '';
        this.musicType = MusicType.Intro;
        const savedOnlinePlayerName = this.localPrefs.getItem(StorageKey.OnlinePlayerName)?.trim();
        if (savedOnlinePlayerName) {
            this.meshSession.updateSelfName(savedOnlinePlayerName);
        }
        this.pregameController = this.createPregameController();
        this.roomSession = new LanRoomSession(this.meshSession, this.gameModes, this.mapFileLoader, this.mapDir, this.mapList);
        this.colyseusClient = new ColyseusClient(this.colyseusUrl);
        this.onlineSession = new OnlineRoomSession(this.meshSession, this.colyseusClient);
    }

    onEnter(): void {
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
        this.roomSession.onSnapshotChange.unsubscribe(this.handleRoomSnapshot);
        this.meshSession.onSnapshotChange.unsubscribe(this.handleMeshSnapshot);
        this.roomSession.onLaunch.unsubscribe(this.handleLaunch);
        this.onlineSession.onDisconnected.unsubscribe(this.handleOnlineDisconnected);
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
        this.roomSession.onSnapshotChange.unsubscribe(this.handleRoomSnapshot);
        this.meshSession.onSnapshotChange.unsubscribe(this.handleMeshSnapshot);
        this.roomSession.onLaunch.unsubscribe(this.handleLaunch);
        this.onlineSession.onDisconnected.unsubscribe(this.handleOnlineDisconnected);
        this.roomSession.onSnapshotChange.subscribe(this.handleRoomSnapshot);
        this.meshSession.onSnapshotChange.subscribe(this.handleMeshSnapshot);
        this.roomSession.onLaunch.subscribe(this.handleLaunch);
        this.onlineSession.onDisconnected.subscribe(this.handleOnlineDisconnected);
    }

    private createPregameController(): PregameController {
        return new PregameController(
            this.strings,
            this.rules,
            this.mapFileLoader,
            this.mapList,
            this.gameModes,
            this.localPrefs,
            this.meshSession.getSelf().name
        );
    }

    private initView(): void {
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            innerRef: (ref: any) => (this.form = ref),
            component: OnlineSetup,
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
            strings: this.strings,
            meshSession: this.meshSession,
            roomSession: this.roomSession,
            onlineSession: this.onlineSession,
            chatHistory: this.chatHistory,
            pregameController: this.pregameController,
            resetNonce: this.resetNonce,
            createRoomRequestId: this.createRoomRequestId,
            onSubmitCreateRoom: async (details: { roomName: string; maxPlayers: number; password: string }) => {
                await this.submitCreateRoom(details);
            },
            onStartGame: async () => {
                await this.startOnlineGame();
            },
            onLeaveRoom: async () => {
                await this.handleLeaveRoom();
            },
            onChangeMap: async () => {
                await this.handleChangeMap();
            },
            onToggleReady: async () => {
                const selfMember = this.roomSession.getSnapshot().members.find((member) => member.isSelf);
                if (!selfMember) {
                    return;
                }
                await this.roomSession.setReady(!selfMember.ready);
            },
            onHostPregameChanged: () => {
                this.roomSession.applyHostPregameSnapshot(this.pregameController.getSnapshot());
                this.refreshSidebarMpText();
                void this.refreshSidebarPreview();
            },
            onCommitName: (name: string) => {
                this.persistOnlinePlayerName(name);
            },
            onJoinRoom: async (roomId: string, password?: string) => {
                await this.handleJoinRoom(roomId, password);
            },
        };
    }

    private requestCreateRoomDialog(): void {
        this.createRoomRequestId += 1;
        this.refreshView();
    }

    private async submitCreateRoom(details: { roomName: string; maxPlayers: number; password: string }): Promise<void> {
        if (!this.pregameController.isInitialized()) {
            await this.pregameController.initialize();
        }
        this.pregameController.updateSelfName(this.meshSession.getSelf().name);
        this.pregameController.setMaxOpenSlots(details.maxPlayers);
        await this.finishCreateRoom(details.roomName, details.password || undefined);
    }

    private async finishCreateRoom(roomName: string, password?: string): Promise<void> {
        const gameOpts = this.pregameController.getGameOpts();
        this.busy = true;
        this.refreshSidebarButtons();
        try {
            await this.onlineSession.createRoom({
                label: roomName,
                mapTitle: gameOpts.mapTitle,
                mapOfficial: gameOpts.mapOfficial,
                gameModeLabel: this.strings.get(this.gameModes.getById(gameOpts.gameMode).label),
                maxSlots: gameOpts.maxSlots,
                password,
            });
            this.roomSession.startHosting(this.createHostSnapshot());
        }
        catch (error) {
            this.messageBoxApi.show(`Failed to create online room: ${(error as Error).message}`);
        }
        finally {
            this.busy = false;
            this.refreshSidebarButtons();
        }
    }

    private async handleJoinRoom(roomId: string, password?: string): Promise<void> {
        if (!this.pregameController.isInitialized()) {
            await this.pregameController.initialize();
        }
        this.pregameController.updateSelfName(this.meshSession.getSelf().name);
        this.busy = true;
        this.refreshSidebarButtons();
        try {
            await this.onlineSession.joinRoom(roomId, password);
        }
        finally {
            this.busy = false;
            this.refreshSidebarButtons();
        }
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
        this.roomSession.leaveRoom();
        this.onlineSession.leaveRoom();
        this.meshSession.reset();
        this.chatHistory.reset();
        this.pregameController = this.createPregameController();
        this.resetNonce += 1;
        this.refreshSidebarButtons();
        this.refreshSidebarMpText();
        this.controller.setSidebarPreview();
        this.refreshView();
    }

    private createHostSnapshot(): any {
        const snapshot = this.pregameController.getSnapshot();
        const visibleSlots = snapshot.gameOpts.humanPlayers[0]?.countryId === OBS_COUNTRY_ID
            ? snapshot.gameOpts.maxSlots + 1
            : snapshot.gameOpts.maxSlots;
        for (let slotIndex = 1; slotIndex < visibleSlots; slotIndex += 1) {
            if (snapshot.slotsInfo[slotIndex]?.type === NetSlotType.Player) {
                continue;
            }
            snapshot.slotsInfo[slotIndex] = { type: NetSlotType.Open };
            snapshot.gameOpts.aiPlayers[slotIndex] = undefined;
        }
        return snapshot;
    }

    private async startOnlineGame(): Promise<void> {
        const roomSnapshot = this.roomSession.getSnapshot();
        if (!roomSnapshot.isHost) {
            return;
        }
        if (!roomSnapshot.canStart) {
            this.messageBoxApi.show('Some members have not finished connection or map sync.');
            return;
        }
        this.roomSession.startGame({
            screenType: MainMenuScreenType.OnlineSetup,
            params: {},
        });
    }

    private refreshSidebarButtons(): void {
        const meshSnapshot = this.meshSession.getSnapshot();
        const roomSnapshot = this.roomSession.getSnapshot();
        const inWaitingRoom = roomSnapshot.isRoomActive || meshSnapshot.isInRoom;

        if (!inWaitingRoom) {
            this.controller.setSidebarButtons([
                {
                    label: 'Create Room',
                    tooltip: 'Set room name, player limit, and optional password',
                    disabled: this.busy,
                    onClick: () => {
                        this.requestCreateRoomDialog();
                    },
                },
                {
                    label: 'Back',
                    tooltip: 'Return to main menu',
                    isBottom: true,
                    onClick: () => this.controller.popScreen(),
                },
            ]);
            return;
        }

        const selfMember = roomSnapshot.members.find((member) => member.isSelf);
        const buttons: any[] = [];

        buttons.push({
            label: 'Start Game',
            tooltip: roomSnapshot.isHost
                ? roomSnapshot.canStart
                    ? 'Broadcast game start descriptor to all members'
                    : 'Wait for connection and map sync to complete'
                : 'Only the host can start the game',
            disabled: !roomSnapshot.isHost || !roomSnapshot.canStart,
            onClick: () => {
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
            console.warn('[OnlineSetupScreen] Failed to refresh sidebar preview', error);
            this.controller.setSidebarPreview();
        }
    }

    private persistOnlinePlayerName(name: string): void {
        const trimmed = name.trim();
        if (!trimmed) {
            this.localPrefs.removeItem(StorageKey.OnlinePlayerName);
            return;
        }
        this.localPrefs.setItem(StorageKey.OnlinePlayerName, trimmed.slice(0, 24));
    }
}
