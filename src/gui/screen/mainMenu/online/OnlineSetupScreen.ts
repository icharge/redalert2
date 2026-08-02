import React from 'react';
import { MainMenuScreen } from '@/gui/screen/mainMenu/MainMenuScreen';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { jsx } from '@/gui/jsx/jsx';
import { OnlineSetup } from '@/gui/screen/mainMenu/online/component/OnlineSetup';
import { CreateRoomForm, CreateRoomFormValues } from '@/gui/screen/mainMenu/online/component/CreateRoomForm';
import { JoinRoomForm } from '@/gui/screen/mainMenu/online/component/JoinRoomForm';
import { MusicType } from '@/engine/sound/Music';
import { LanMeshSession } from '@/network/lan/LanMeshSession';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { LanRoomSession } from '@/network/lan/LanRoomSession';
import { PregameController } from '@/gui/screen/mainMenu/lobby/PregameController';
import { MainMenuScreenType } from '@/gui/screen/ScreenType';
import { StorageKey } from '@/LocalPrefs';
import { SlotType as NetSlotType } from '@/network/gameopt/SlotInfo';
import { OBS_COUNTRY_ID } from '@/game/gameopts/constants';
import { ColyseusClient, OnlineRoomListing } from '@/network/colyseus/ColyseusClient';
import { OnlineRoomSession } from '@/network/colyseus/OnlineRoomSession';
import { LobbyChannelSession } from '@/network/colyseus/LobbyChannelSession';
import { OnlineRoomScreen } from '@/gui/screen/mainMenu/online/OnlineRoomScreen';

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
    show(message: any, buttons?: any, callback?: any): void;
}

interface MapDirectory {
    containsEntry(entryName: string): Promise<boolean>;
    writeFile(file: any): Promise<void>;
}

interface RootController {
    goToScreen(screenType: number, params?: any): void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
// Matches MatchmakingRoom's RECONNECT_GRACE_SECONDS on the server.
const LINK_DROP_GRACE_MILLIS = 10000;

function generatePeerId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
        const random = (Math.random() * 16) | 0;
        const value = char === 'x' ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

const SESSION_PEER_ID_KEY = '_r_onlinePeerId';

/**
 * Deliberately backed by sessionStorage, not the shared LocalPrefs
 * (localStorage): this id needs to survive a reload of *this* tab (so a
 * reconnecting client can be recognized as the same peer) while staying
 * independent per browser tab — localStorage is shared across every tab of
 * the same origin, which would collide two tabs open in the same browser
 * onto the same "self" id.
 */
function getOrCreateSessionPeerId(): string {
    try {
        const existing = sessionStorage.getItem(SESSION_PEER_ID_KEY);
        if (existing) {
            return existing;
        }
        const generated = generatePeerId();
        sessionStorage.setItem(SESSION_PEER_ID_KEY, generated);
        return generated;
    }
    catch {
        return generatePeerId();
    }
}

export class OnlineSetupScreen extends MainMenuScreen {
    declare public title: string;
    declare public musicType: MusicType;

    private form?: any;
    private resetNonce = 0;
    private busy = false;
    private roomScreen?: OnlineRoomScreen;
    private selectedRoom?: OnlineRoomListing;

    private readonly meshSession: LanMeshSession;
    private readonly chatHistory = new ChatHistory();
    private readonly roomSession: LanRoomSession;
    private readonly colyseusClient: ColyseusClient;
    private readonly onlineSession: OnlineRoomSession;
    private readonly lobbySession: LobbyChannelSession;
    private readonly lobbyChatHistory = new ChatHistory();
    private pregameController: PregameController;

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
        this.meshSession = new LanMeshSession(DEFAULT_ICE_SERVERS, getOrCreateSessionPeerId(), LINK_DROP_GRACE_MILLIS);
        const savedOnlinePlayerName = this.localPrefs.getItem(StorageKey.OnlinePlayerName)?.trim();
        if (savedOnlinePlayerName) {
            this.meshSession.updateSelfName(savedOnlinePlayerName);
        }
        this.pregameController = this.createPregameController();
        this.roomSession = new LanRoomSession(this.meshSession, this.gameModes, this.mapFileLoader, this.mapDir, this.mapList);
        this.colyseusClient = new ColyseusClient(this.colyseusUrl);
        this.onlineSession = new OnlineRoomSession(this.meshSession, this.colyseusClient);
        this.lobbySession = new LobbyChannelSession(this.colyseusClient);
    }

    onEnter(): void {
        this.controller.toggleMainVideo(false);
        this.initView();
        this.refreshSidebarButtons();
        this.controller.showSidebarButtons();
        void this.joinLobbyChannel();
    }

    async onLeave(): Promise<void> {
        await this.controller.hideSidebarButtons();
        this.form = undefined;
        this.lobbySession.leave();
    }

    async onStack(): Promise<void> {
        await this.onLeave();
    }

    onUnstack(): void {
        this.pregameController = this.createPregameController();
        this.resetNonce += 1;
        this.refreshSidebarButtons();
        this.refreshView();
        this.controller.showSidebarButtons();
        void this.joinLobbyChannel();
    }

    private async joinLobbyChannel(): Promise<void> {
        if (this.lobbySession.isConnected()) {
            return;
        }
        try {
            await this.lobbySession.join(this.meshSession.getSelf().name);
        }
        catch {
            // Non-fatal — room browsing still works without global chat/presence.
        }
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
            meshSession: this.meshSession,
            onlineSession: this.onlineSession,
            lobbySession: this.lobbySession,
            lobbyChatHistory: this.lobbyChatHistory,
            resetNonce: this.resetNonce,
            strings: this.strings,
            onCommitName: (name: string) => {
                this.persistOnlinePlayerName(name);
                this.lobbySession.rename(name);
            },
            onRequestJoinRoom: (room: OnlineRoomListing) => {
                this.openJoinRoomDialog(room);
            },
            onSelectRoom: (room: OnlineRoomListing | undefined) => {
                this.selectedRoom = room;
                this.refreshSidebarButtons();
            },
        };
    }

    private openCreateRoomDialog(): void {
        const valuesRef: { current: CreateRoomFormValues } = {
            current: { description: '', maxPlayers: 8, password: '' },
        };
        const submit = () => {
            void this.submitCreateRoom(valuesRef.current);
        };
        this.messageBoxApi.show(
            React.createElement(CreateRoomForm, { valuesRef, onSubmit: submit }),
            [
                { label: 'Create Room', onClick: submit },
                { label: 'Cancel' },
            ],
            { className: 'prompt-box' }
        );
    }

    private openJoinRoomDialog(room: OnlineRoomListing): void {
        const valuesRef: { current: { password: string } } = { current: { password: '' } };
        const submit = () => {
            void this.handleJoinRoom(room.roomId, valuesRef.current.password.trim() || undefined);
        };
        this.messageBoxApi.show(
            React.createElement(JoinRoomForm, {
                hostName: room.metadata.hostName,
                description: room.metadata.description || undefined,
                passwordRequired: room.metadata.passwordProtected,
                valuesRef,
                onSubmit: submit,
            }),
            [
                { label: 'Join', onClick: submit },
                { label: 'Cancel' },
            ],
            { className: 'prompt-box' }
        );
    }

    private async submitCreateRoom(details: { description: string; maxPlayers: number; password: string }): Promise<void> {
        if (!this.pregameController.isInitialized()) {
            await this.pregameController.initialize();
        }
        this.pregameController.updateSelfName(this.meshSession.getSelf().name);
        this.pregameController.setMaxOpenSlots(details.maxPlayers);
        await this.finishCreateRoom(details.description, details.password || undefined);
    }

    private async finishCreateRoom(description: string, password?: string): Promise<void> {
        const gameOpts = this.pregameController.getGameOpts();
        this.busy = true;
        this.refreshSidebarButtons();
        let enteredRoom = false;
        try {
            await this.onlineSession.createRoom({
                description: description.trim(),
                mapTitle: gameOpts.mapTitle,
                mapOfficial: gameOpts.mapOfficial,
                gameModeLabel: this.strings.get(this.gameModes.getById(gameOpts.gameMode).label),
                maxSlots: gameOpts.maxSlots,
                password,
            });
            this.roomSession.startHosting(this.createHostSnapshot());
            await this.enterRoomScreen();
            enteredRoom = true;
        }
        catch (error) {
            this.messageBoxApi.show(`Failed to create online room: ${(error as Error).message}`, 'OK');
        }
        finally {
            this.busy = false;
            // Once enterRoomScreen() has navigated away, this screen no longer
            // owns the sidebar — refreshing it here would stomp on OnlineRoomScreen's.
            if (!enteredRoom) {
                this.refreshSidebarButtons();
            }
        }
    }

    private async handleJoinRoom(roomId: string, password?: string): Promise<void> {
        if (!this.pregameController.isInitialized()) {
            await this.pregameController.initialize();
        }
        this.pregameController.updateSelfName(this.meshSession.getSelf().name);
        this.busy = true;
        this.refreshSidebarButtons();
        let enteredRoom = false;
        try {
            await this.onlineSession.joinRoom(roomId, password);
            await this.enterRoomScreen();
            enteredRoom = true;
        }
        catch (error) {
            this.messageBoxApi.show(`Failed to join online room: ${(error as Error).message}`, 'OK');
        }
        finally {
            this.busy = false;
            if (!enteredRoom) {
                this.refreshSidebarButtons();
            }
        }
    }

    private async enterRoomScreen(): Promise<void> {
        this.ensureRoomScreenRegistered();
        await this.controller.pushScreen(MainMenuScreenType.OnlineRoom, {
            meshSession: this.meshSession,
            roomSession: this.roomSession,
            onlineSession: this.onlineSession,
            pregameController: this.pregameController,
            chatHistory: this.chatHistory,
        });
    }

    private ensureRoomScreenRegistered(): void {
        if (this.roomScreen) {
            return;
        }
        this.roomScreen = new OnlineRoomScreen(
            this.rootController,
            this.strings,
            this.jsxRenderer,
            this.mapFileLoader,
            this.gameModes,
            this.messageBoxApi
        );
        this.roomScreen.setController(this.controller);
        this.controller.addScreen(MainMenuScreenType.OnlineRoom, this.roomScreen);
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

    private refreshSidebarButtons(): void {
        this.controller.setSidebarButtons([
            {
                label: 'Create Game',
                tooltip: 'Set room description, player limit, and optional password',
                disabled: this.busy,
                onClick: () => {
                    this.openCreateRoomDialog();
                },
            },
            {
                label: 'Join Game',
                tooltip: this.selectedRoom ? 'Join the selected room' : 'Select a room from the list first',
                disabled: this.busy || !this.selectedRoom,
                onClick: () => {
                    if (this.selectedRoom) {
                        this.openJoinRoomDialog(this.selectedRoom);
                    }
                },
            },
            {
                label: 'Back',
                tooltip: 'Return to main menu',
                isBottom: true,
                onClick: () => this.controller.popScreen(),
            },
        ]);
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
