import { Renderer } from "@/engine/gfx/Renderer";
import { UiScene } from "@/gui/UiScene";
import { Hud } from "@/gui/screen/game/component/Hud";
import { Engine } from "@/engine/Engine";
import { Rules } from "@/game/rules/Rules";
import { Art } from "@/game/art/Art";
import { Country } from "@/game/Country";
import { World } from "@/game/World";
import { ObjectFactory } from "@/game/gameobject/ObjectFactory";
import { UiAnimationLoop } from "@/engine/UiAnimationLoop";
import { Game } from "@/game/Game";
import { JsxRenderer } from "@/gui/jsx/JsxRenderer";
import { CompositeDisposable } from "@/util/disposable/CompositeDisposable";
import { Alliances } from "@/game/Alliances";
import { PlayerList } from "@/game/PlayerList";
import { Pointer } from "@/gui/Pointer";
import { BoxedVar } from "@/util/BoxedVar";
import { TileCollection } from "@/game/map/TileCollection";
import { TileOccupation } from "@/game/map/TileOccupation";
import { Bridges } from "@/game/map/Bridges";
import { UnitSelection } from "@/game/gameobject/selection/UnitSelection";
import { GameModeType } from "@/game/ini/GameModeType";
import { getRandomInt } from "@/util/math";
import { TheaterType } from "@/engine/TheaterType";
import { GameMap } from "@/game/GameMap";
import { RadarTrait } from "@/game/player/trait/RadarTrait";
import { Production } from "@/game/player/production/Production";
import { CombatantSidebarModel } from "@/gui/screen/game/component/hud/viewmodel/CombatantSidebarModel";
import { MessageList } from "@/gui/screen/game/component/hud/viewmodel/MessageList";
import { MapShroudTrait } from "@/game/trait/MapShroudTrait";
import { SellTrait } from "@/game/trait/SellTrait";
import { MapBounds } from "@/game/map/MapBounds";
import { mixDatabase } from "@/engine/mixDatabase";
import { CommandBarButtonType } from "@/gui/screen/game/component/hud/commandBar/CommandBarButtonType";
import { CanvasMetrics } from "@/gui/CanvasMetrics";
import { StalemateDetectTrait } from "@/game/trait/StalemateDetectTrait";
import { CountdownTimer } from "@/game/CountdownTimer";
import { ChatHistory } from "@/gui/chat/ChatHistory";
import { PlayerFactory } from "@/game/player/PlayerFactory";
import { ResourceType } from "@/engine/resourceConfigs";
import { GameMenuController } from "@/gui/screen/game/gameMenu/GameMenuController";
import { ConnectionInfoScreen } from "@/gui/screen/game/gameMenu/ConnectionInfoScreen";
import { ScreenType } from "@/gui/screen/game/gameMenu/ScreenType";
import { PlayerConnectionStatus } from "@/network/gamestate/PlayerConnectionStatus";
import { VoteChoice, VoteSessionInfo, VoteTally } from "@/network/GservConnection";
import { EventDispatcher } from "@/util/event";
import { TestToolSupport, type TestToolRuntimeContext } from "@/tools/TestToolSupport";

// Mirrors the server defaults in server/src/config.ts so what this tool shows
// matches a real match. Plain constants rather than imports: server/src and src
// are separate codebases, the same reason GservServer hardcodes the
// PlayerConnectionStatus values it reports over the wire.
const VOTE_MIN_REQUIRED_PLAYERS = 3;
const VOTE_EXTENSIONS_MAX = 2;
const VOTE_EXTENSION_SECONDS = 30;
const RECONNECT_GRACE_SECONDS = 30;
const VOTE_OPEN_DELAY_MILLIS = 10_000;

const PLAYER_COLORS = ["#2269d4", "#ff1818", "#18c418", "#e0c018", "#a018e0"];
const PLAYER_COUNTRIES = ["Americans", "Russians", "French", "Germans", "British"];

type SimStatus = "connected" | "dropped" | "rejoining" | "left";

interface SimPlayer {
    name: string;
    color: { asHexString(): string };
    country: { name: string };
    isAi: boolean;
    isObserver: boolean;
    status: SimStatus;
    ping: number;
    loadPercent: number;
    timeoutAt?: number;
}

// One open kick/wait vote, same shape as GservServer's VoteSession.
interface SimVoteSession {
    votes: Map<string, VoteChoice>;
    extensionsRemaining: number;
    chargedWaitVoters: Set<string>;
}

// Stands in for the real GservConnection. Everything ConnectionInfoScreen
// consumes goes through here, in the server's own wire format where there is
// one (loadinfo), so the screen exercises its real parsing and subscription
// paths rather than being handed pre-digested objects.
class FakeGservConnection {
    private _onLoadInfo = new EventDispatcher<FakeGservConnection, string>();
    private _onVoteSessionOpened = new EventDispatcher<FakeGservConnection, VoteSessionInfo>();
    private _onVoteUpdate = new EventDispatcher<FakeGservConnection, VoteTally>();
    private _onVoteSessionClosed = new EventDispatcher<FakeGservConnection, string>();
    constructor(private buildLoadInfo: () => string, private onVoteCast: (targetNick: string, choice: VoteChoice) => void) { }
    get onLoadInfo() {
        return this._onLoadInfo.asEvent();
    }
    get onVoteSessionOpened() {
        return this._onVoteSessionOpened.asEvent();
    }
    get onVoteUpdate() {
        return this._onVoteUpdate.asEvent();
    }
    get onVoteSessionClosed() {
        return this._onVoteSessionClosed.asEvent();
    }
    isOpen(): boolean {
        return true;
    }
    // The screen polls this once a second; answer it the way the server does,
    // by dispatching RPL_LOAD_INFO's payload back.
    requestLoadInfo(): void {
        this._onLoadInfo.dispatch(this, this.buildLoadInfo());
    }
    sendVote(targetNick: string, choice: VoteChoice): void {
        this.onVoteCast(targetNick, choice);
    }
    emitVoteSessionOpened(info: VoteSessionInfo): void {
        this._onVoteSessionOpened.dispatch(this, info);
    }
    emitVoteUpdate(tally: VoteTally): void {
        this._onVoteUpdate.dispatch(this, tally);
    }
    emitVoteSessionClosed(targetNick: string): void {
        this._onVoteSessionClosed.dispatch(this, targetNick);
    }
}

export class ConInfoFormTester {
    private static disposables = new CompositeDisposable();
    private static homeButton?: HTMLButtonElement;
    private static panel?: HTMLElement;
    // Only this part of the panel is repainted on the timer -- see renderNowBlock.
    private static nowBlock?: HTMLElement;
    // Rebuilding the panel swaps out every button. If that happens between a
    // mousedown and its mouseup, the two events land on different elements and
    // the browser fires no click at all -- the button silently needs pressing
    // again. Several paths request a rebuild (a click handler, the async
    // screen reopen that follows it, a vote resolving), so rather than police
    // each one, all rebuilds route through requestPanelRebuild and are held
    // while a press is in progress.
    private static pointerDown = false;
    private static rebuildPending = false;
    private static controller?: GameMenuController;
    private static gservCon?: FakeGservConnection;
    private static players: SimPlayer[] = [];
    private static sessions = new Map<string, SimVoteSession>();
    // Departed nick -> when their vote is due to open. The server does not open
    // a vote the instant someone drops; it waits voteOpenDelayMillis and only
    // opens if they are still gone (GservServer.scheduleVoteOpen), because most
    // drops resolve themselves in a few seconds. Reproduced here rather than
    // giving the panel an "open vote" button, which made the real behaviour
    // look like a manual step it isn't.
    private static pendingVoteOpenAt = new Map<string, number>();
    private static localName = "";
    private static walkStep = -1;
    private static log: string[] = [];

    static async main(gameMap: any, container: HTMLElement, strings: any, context: TestToolRuntimeContext = {}): Promise<void> {
        await TestToolSupport.ensureTheater(TheaterType.Temperate, context.cdnResourceLoader, [ResourceType.UiAlly, ResourceType.Cameo]);
        const hostElement = TestToolSupport.prepareHost(context, 800, 600);
        const renderer = new Renderer(800, 600);
        renderer.init(hostElement);
        TestToolSupport.placeRendererCanvas(renderer, 0, 0);
        this.disposables.add(renderer);
        const uiScene = UiScene.factory({ x: 0, y: 0, width: 800, height: 600 });
        this.disposables.add(uiScene);

        // A minimal but real game/player, only so the HUD has the model it
        // needs. Lifted from ShpTester, which is the existing precedent for
        // standing a real Hud up outside a match.
        const cameoDatabase = mixDatabase.get("cameo.mix");
        if (!cameoDatabase) {
            throw new Error("Missing file list database for cameos");
        }
        const rules = new Rules(Engine.getRules());
        const art = new Art(rules, Engine.getArt(), undefined, undefined);
        const theater = await Engine.loadTheater(TheaterType.Temperate);
        const gameMapInstance = new GameMap(gameMap, theater.tileSets, rules, (min: number, max: number) => getRandomInt(min, max));
        const gameOptions = { superWeapons: false, gameSpeed: 5 };
        const playerFactory = new PlayerFactory(rules, gameOptions, []);
        const country = Country.factory("Americans", rules as any);
        const player = playerFactory.createCombatant("charge", country, 0, "Red", false, undefined);
        (player as any).radarTrait = new RadarTrait();
        (player as any).production = new Production(player, 10, gameOptions, rules, [
            ...(rules as any).buildingRules.values(),
            ...(rules as any).infantryRules.values(),
        ]);
        this.disposables.add(player);
        const world = new World();
        const playerList = new PlayerList();
        const alliances = new Alliances(playerList);
        const unitSelection = new UnitSelection();
        const tileCollection = new TileCollection([], null, rules.general, () => getRandomInt(0, 1000));
        const tileOccupation = new TileOccupation(tileCollection);
        const mapBounds = new MapBounds();
        const bridges = new Bridges(theater.tileSets, tileCollection, tileOccupation as unknown as ConstructorParameters<typeof Bridges>[2], mapBounds, rules);
        const gameSpeedVar = new BoxedVar(1);
        const objectFactory = new ObjectFactory(tileCollection, tileOccupation, bridges, gameSpeedVar);
        const game = new Game(world, gameMapInstance, rules, art, null, "0", 0, gameOptions as unknown as ConstructorParameters<typeof Game>[7], GameModeType.Battle, playerList, unitSelection, alliances, gameSpeedVar, objectFactory, null);
        game.addPlayer(player);
        game.mapShroudTrait = new MapShroudTrait(gameMapInstance, alliances);
        game.traits.add(game.mapShroudTrait);
        game.sellTrait = new SellTrait(game, game.rules.general);
        game.traits.add(game.sellTrait);
        (player as any).radarTrait.setDisabled(false);
        player.credits = 5000;
        const sidebarModel = new CombatantSidebarModel(player, game);
        sidebarModel.powerDrained = 150;
        sidebarModel.powerGenerated = 300;

        const canvasMetrics = new CanvasMetrics(renderer.getCanvas(), window);
        canvasMetrics.init();
        this.disposables.add(canvasMetrics);
        const pointer = Pointer.factory(Engine.getImages().get("mouse.shp"), Engine.getPalettes().get("mousepal.pal"), renderer, document, canvasMetrics, new BoxedVar(false));
        pointer.init();
        this.disposables.add(pointer);
        uiScene.add(pointer.getSprite());
        const jsxRenderer = new JsxRenderer(Engine.getImages(), Engine.getPalettes(), uiScene.getCamera(), pointer.pointerEvents);
        const messageList = new MessageList((game.rules.audioVisual as unknown as { messageDuration: number }).messageDuration, 6, player);
        const hud = new Hud((player.country as any).side, uiScene.viewport, Engine.getImages() as any, Engine.getPalettes() as any, cameoDatabase, sidebarModel, messageList, new ChatHistory(), new BoxedVar(""), new BoxedVar(false), player, [player], new StalemateDetectTrait(), new CountdownTimer(), jsxRenderer, strings, Object.values(CommandBarButtonType).filter(value => typeof value === "number") as CommandBarButtonType[], undefined);
        uiScene.add(hud);
        this.disposables.add(hud);

        this.setRoster(3);
        this.gservCon = new FakeGservConnection(
            () => this.buildLoadInfoPayload(),
            (targetNick, choice) => this.castVote(this.localName, targetNick, choice),
        );

        // The real in-game menu stack, driving the real ConnectionInfoScreen --
        // so this shows the actual sidebar, the actual content area, and the
        // screen's own subscription/refresh logic, not a re-creation of them.
        const controller = this.controller = new GameMenuController(hud as any);
        const screen = new ConnectionInfoScreen(strings, jsxRenderer as any);
        screen.setController?.(controller as any);
        controller.addScreen(ScreenType.ConnectionInfo, screen as any);
        this.disposables.add(controller);
        await this.openScreen();

        renderer.addScene(uiScene);
        const animationLoop = new UiAnimationLoop(renderer);
        animationLoop.start();
        this.disposables.add(animationLoop);
        hostElement.appendChild(uiScene.getHtmlContainer().getElement());
        this.disposables.add(() => uiScene.getHtmlContainer().getElement().remove());

        // The screen already polls requestLoadInfo() once a second, which is
        // what refreshes the countdown and the rejoin progress bar -- so only
        // the simulated catch-up needs its own advance here.
        const ticker = setInterval(() => {
            for (const simPlayer of this.players) {
                if (simPlayer.status === "rejoining" && simPlayer.loadPercent < 100) {
                    simPlayer.loadPercent = Math.min(100, simPlayer.loadPercent + 2);
                }
            }
            const now = Date.now();
            let voteOpened = false;
            for (const [nick, dueAt] of [...this.pendingVoteOpenAt]) {
                if (now >= dueAt) {
                    this.pendingVoteOpenAt.delete(nick);
                    this.openVote(nick);
                    voteOpened = true;
                }
            }
            if (voteOpened) {
                // A vote opening adds whole controls, so the panel genuinely has
                // to be rebuilt -- but only on that one tick.
                this.requestPanelRebuild();
            }
            else {
                this.renderNowBlock();
            }
        }, 250);
        this.disposables.add(() => clearInterval(ticker));

        this.buildHomeButton(container);
        this.buildPanel(container);
        TestToolSupport.setState("coninfo", {
            playerCount: this.players.length,
            voteMinRequiredPlayers: VOTE_MIN_REQUIRED_PLAYERS,
        });
    }

    // Awaits the navigation before pushing any state, because Controller's
    // goToScreen is fire-and-forget async: the screen does not subscribe to
    // anything until its onEnter has run, so a requestLoadInfo() fired straight
    // after the call reaches nobody and the screen comes up blank.
    private static async openScreen(): Promise<void> {
        const chatHistory = new ChatHistory();
        // goToScreenBlocking, not goToScreen: it already leaves whatever is
        // showing before pushing. Calling controller.close() first as well ran
        // two independent pop loops against the same stack, and the slower one
        // popped the screen the other had just pushed -- which is why switching
        // "you are <player>" appeared to do nothing.
        await this.controller?.goToScreenBlocking(ScreenType.ConnectionInfo, {
            players: this.players,
            localPlayer: this.localPlayer(),
            chatHistory,
            gservCon: this.gservCon,
            chatNetHandler: {
                submitMessage: (message: string, recipient: any) => this.addLog(`chat -> ${recipient}: ${message}`),
            },
            onQuit: () => this.addLog("Abort Mission clicked"),
        });
        // ConInfoForm's chat box focuses itself when it mounts (ChatInput's
        // mount-only useEffect), which is right in a real match but not here:
        // every reopen would pull focus off the tool being used to drive it.
        // Deferred a turn because that effect runs after React commits, i.e.
        // after this function returns -- blurring inline would happen first and
        // the input would simply take focus back.
        setTimeout(() => {
            const focused = document.activeElement as HTMLElement | null;
            if (focused && focused !== document.body && !this.panel?.contains(focused)) {
                focused.blur();
            }
        }, 0);
        this.gservCon?.requestLoadInfo();
        // Rebroadcast any open vote so it survives the reopen. The real server
        // does NOT do this -- see docs/reconnection-improvements.md 13.4, where
        // a reopened screen stays blank until the next vote is cast. Replayed
        // here anyway so switching viewer mid-vote stays usable as a tool.
        for (const [targetNick] of this.sessions) {
            this.gservCon?.emitVoteSessionOpened({
                targetNick,
                extensionsMax: VOTE_EXTENSIONS_MAX,
                extensionSeconds: VOTE_EXTENSION_SECONDS,
            });
            this.broadcastTally(targetNick);
        }
    }

    // Reopening is the only way to change players/localPlayer, which the screen
    // reads once in onEnter. `then` runs after the new screen is live, so
    // anything it emits actually has a subscriber.
    private static reopenScreen(then?: () => void): void {
        this.openScreen()
            .then(() => {
                then?.();
                this.requestPanelRebuild();
            })
            .catch((error) => console.error("[ConInfoFormTester] reopen failed", error));
    }

    // ---- simulation state -------------------------------------------------

    private static setRoster(humanCount: number): void {
        this.sessions.clear();
        this.pendingVoteOpenAt.clear();
        this.players = Array.from({ length: humanCount }, (_, i) => ({
            name: i === 0 ? "charge" : `player${i + 1}`,
            color: { asHexString: () => PLAYER_COLORS[i % PLAYER_COLORS.length] },
            country: { name: PLAYER_COUNTRIES[i % PLAYER_COUNTRIES.length] },
            isAi: false,
            isObserver: false,
            status: "connected" as SimStatus,
            ping: 40 + i * 60,
            loadPercent: 0,
        }));
        this.localName = this.players[0].name;
    }

    private static localPlayer(): SimPlayer {
        return this.players.find(p => p.name === this.localName) ?? this.players[0];
    }

    // The live equivalent of GservServer's requiredNicks: every non-observer
    // roster player who has not permanently left. A dropped player is still
    // required -- that is exactly why the relay holds for them.
    private static requiredCount(): number {
        return this.players.filter(p => !p.isObserver && p.status !== "left").length;
    }

    private static isEligibleVoter(nick: string, targetNick: string): boolean {
        const player = this.players.find(p => p.name === nick);
        return !!player
            && nick !== targetNick
            && !player.isObserver
            && player.status !== "left"
            && player.status !== "dropped";
    }

    // RPL_LOAD_INFO's payload, byte for byte what GservServer.sendLoadInfo
    // builds: "<nick>,<status>,<loaded>,0,0,<timeoutAt>" per player.
    private static buildLoadInfoPayload(): string {
        return this.players
            .map((player) => {
                const status = player.status === "connected"
                    ? PlayerConnectionStatus.Connected
                    : player.status === "rejoining"
                        ? PlayerConnectionStatus.Rejoining
                        : PlayerConnectionStatus.NotConnected;
                return `${player.name},${status},${player.loadPercent},${player.ping},45000,${player.timeoutAt ?? 0}`;
            })
            .join(",");
    }

    private static tallyFor(targetNick: string): VoteTally | undefined {
        const session = this.sessions.get(targetNick);
        if (!session) {
            return undefined;
        }
        const eligible = this.players.map(p => p.name).filter(nick => this.isEligibleVoter(nick, targetNick));
        let kickVotes = 0;
        let waitVotes = 0;
        const votesByNick = new Map<string, VoteChoice>();
        for (const nick of eligible) {
            const choice = session.votes.get(nick);
            if (!choice) {
                continue;
            }
            votesByNick.set(nick, choice);
            if (choice === "kick") {
                kickVotes += 1;
            }
            else {
                waitVotes += 1;
            }
        }
        return {
            targetNick,
            kickVotes,
            waitVotes,
            extensionsRemaining: session.extensionsRemaining,
            eligibleCount: eligible.length,
            majorityThreshold: Math.floor(eligible.length / 2) + 1,
            votesByNick,
        };
    }

    private static broadcastTally(targetNick: string): void {
        const tally = this.tallyFor(targetNick);
        if (tally) {
            this.gservCon?.emitVoteUpdate(tally);
        }
    }

    private static openVote(targetNick: string): void {
        if (this.requiredCount() < VOTE_MIN_REQUIRED_PLAYERS) {
            this.addLog(`vote NOT opened on ${targetNick}: ${this.requiredCount()} required, need ${VOTE_MIN_REQUIRED_PLAYERS}`);
            return;
        }
        if (this.sessions.has(targetNick)) {
            return;
        }
        this.sessions.set(targetNick, { votes: new Map(), extensionsRemaining: VOTE_EXTENSIONS_MAX, chargedWaitVoters: new Set() });
        this.addLog(`vote opened on ${targetNick}`);
        this.gservCon?.emitVoteSessionOpened({
            targetNick,
            extensionsMax: VOTE_EXTENSIONS_MAX,
            extensionSeconds: VOTE_EXTENSION_SECONDS,
        });
        this.resolve(targetNick);
    }

    private static closeVote(targetNick: string, reason: string): void {
        if (this.sessions.delete(targetNick)) {
            this.addLog(`vote on ${targetNick} closed (${reason})`);
            this.gservCon?.emitVoteSessionClosed(targetNick);
        }
    }

    private static castVote(voter: string, targetNick: string, choice: VoteChoice): void {
        const session = this.sessions.get(targetNick);
        if (!session || !this.isEligibleVoter(voter, targetNick)) {
            return;
        }
        // Votes are final, exactly as GservServer.handleVote enforces.
        if (session.votes.has(voter)) {
            this.addLog(`${voter}'s vote is already cast and cannot change`);
            return;
        }
        session.votes.set(voter, choice);
        this.addLog(`${voter} voted ${choice} on ${targetNick}`);
        this.resolve(targetNick);
        this.requestPanelRebuild();
    }

    // A faithful port of GservServer.resolveVote: the electorate is recomputed
    // every tally, an extension is spent only on the 0 -> nonzero wait
    // transition, and vetoActive is read *after* that spend so the vote
    // draining the last extension does not itself veto. Deliberately kept in
    // step with the server -- the point of this tool is to watch the real rules
    // play out, so a divergence here would be a bug in the tool.
    private static resolve(targetNick: string): void {
        const session = this.sessions.get(targetNick);
        if (!session) {
            return;
        }
        const eligible = this.players.map(p => p.name).filter(nick => this.isEligibleVoter(nick, targetNick));
        if (eligible.length + 1 < VOTE_MIN_REQUIRED_PLAYERS) {
            this.closeVote(targetNick, "electorate fell below the minimum");
            return;
        }
        let kickVotes = 0;
        let waitVotes = 0;
        for (const nick of eligible) {
            const choice = session.votes.get(nick);
            if (choice === "kick") {
                kickVotes += 1;
            }
            else if (choice === "wait") {
                waitVotes += 1;
            }
        }
        const hasWaitVote = waitVotes > 0;
        // Every wait voter buys one extension, once.
        for (const nick of eligible) {
            if (session.votes.get(nick) !== "wait"
                || session.chargedWaitVoters.has(nick)
                || session.extensionsRemaining <= 0) {
                continue;
            }
            session.chargedWaitVoters.add(nick);
            session.extensionsRemaining -= 1;
            const target = this.players.find(p => p.name === targetNick);
            if (target?.timeoutAt !== undefined) {
                target.timeoutAt += VOTE_EXTENSION_SECONDS * 1000;
            }
            this.addLog(`${nick}'s wait vote extended ${targetNick} by ${VOTE_EXTENSION_SECONDS}s (${session.extensionsRemaining} left)`);
        }
        const majorityThreshold = Math.floor(eligible.length / 2) + 1;
        const vetoActive = hasWaitVote && session.extensionsRemaining > 0;
        this.broadcastTally(targetNick);
        if (eligible.length > 0 && kickVotes >= majorityThreshold && !vetoActive) {
            const target = this.players.find(p => p.name === targetNick);
            if (target) {
                target.status = "left";
                target.timeoutAt = undefined;
            }
            this.closeVote(targetNick, "kick majority carried");
            this.addLog(`${targetNick} resigned early by vote`);
        }
        else if (hasWaitVote && !vetoActive) {
            this.addLog(`wait votes now advisory: extensions exhausted on ${targetNick}`);
        }
        this.gservCon?.requestLoadInfo();
    }

    private static setStatus(nick: string, status: SimStatus): void {
        const player = this.players.find(p => p.name === nick);
        if (!player) {
            return;
        }
        player.status = status;
        if (status === "dropped") {
            player.timeoutAt = Date.now() + RECONNECT_GRACE_SECONDS * 1000;
            player.loadPercent = 0;
            this.addLog(`${nick} dropped; ${RECONNECT_GRACE_SECONDS}s grace window opened`);
            if (this.requiredCount() >= VOTE_MIN_REQUIRED_PLAYERS) {
                this.pendingVoteOpenAt.set(nick, Date.now() + VOTE_OPEN_DELAY_MILLIS);
                this.addLog(`vote on ${nick} scheduled in ${VOTE_OPEN_DELAY_MILLIS / 1000}s if still away`);
            }
            else {
                this.addLog(`no vote scheduled: ${this.requiredCount()} required, needs ${VOTE_MIN_REQUIRED_PLAYERS}`);
            }
        }
        else {
            player.timeoutAt = undefined;
            // Any departure that resolves ends the vote about it -- and cancels
            // one that had not opened yet -- matching handleRejoin /
            // handleLeave / expireDeparted calling both closeVoteSession and
            // cancelPendingVoteOpen.
            if (this.pendingVoteOpenAt.delete(nick)) {
                this.addLog(`pending vote on ${nick} cancelled (never opened)`);
            }
            this.closeVote(nick, status === "rejoining" ? "player reconnected" : "departure resolved");
            if (status === "rejoining") {
                player.loadPercent = 0;
            }
        }
        // Everyone else's open votes just changed electorate, exactly like
        // handleClose re-tallying every other session on a drop.
        for (const targetNick of [...this.sessions.keys()]) {
            if (targetNick !== nick) {
                this.resolve(targetNick);
            }
        }
        this.gservCon?.requestLoadInfo();
    }

    private static addLog(line: string): void {
        this.log.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
        this.log = this.log.slice(0, 10);
    }

    // ---- control panel ----------------------------------------------------

    private static buildPanel(parent: HTMLElement): void {
        const panel = this.panel = document.createElement("div");
        panel.style.cssText = `
      position: fixed;
      right: 12px;
      top: 12px;
      width: 400px;
      max-height: calc(100vh - 24px);
      overflow-y: auto;
      padding: 10px;
      font: 12px/1.5 monospace;
      z-index: 1000;
    `;
        panel.addEventListener("pointerdown", () => {
            this.pointerDown = true;
        });
        // On window, not the panel: a press that starts on a button but is
        // released anywhere else still has to clear the flag.
        const release = () => {
            this.pointerDown = false;
            if (this.rebuildPending) {
                this.rebuildPending = false;
                // Deferred a turn, not called straight away: pointerup fires
                // *before* click, so rebuilding synchronously here would detach
                // the pressed button before its click event dispatches --
                // swallowing the very click this guard exists to protect.
                setTimeout(() => this.renderPanelBody(), 0);
            }
        };
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
        this.disposables.add(() => {
            window.removeEventListener("pointerup", release);
            window.removeEventListener("pointercancel", release);
        });
        parent.appendChild(panel);
        // The game is centred in the viewport, so a fixed-position panel of any
        // real width sits on top of the HUD sidebar. Reserving the space on the
        // body shifts that centring left instead of covering it.
        const previousPadding = document.body.style.paddingRight;
        document.body.style.paddingRight = "424px";
        this.disposables.add(() => {
            panel.remove();
            document.body.style.paddingRight = previousPadding;
        });
        this.requestPanelRebuild();
    }

    // An ordered tour of the whole feature. Each step puts the simulation into
    // a known state and says what to look at on the screen to its left, so the
    // behaviour can be reviewed without knowing which panel control produces
    // which situation.
    private static readonly walkthrough: Array<{ title: string; watch: string; run: () => void }> = [
        {
            title: "3 players, everyone connected",
            watch: "Baseline. No Vote column, no badges, plain ping/time cells.",
            run: () => {
                ConInfoFormTester.setRoster(3);
                ConInfoFormTester.reopenScreen();
            },
        },
        {
            title: "player2 drops",
            watch: "Row dims, gets a reconnect badge, and the Time cell counts "
                + "down from 30s. No Vote column yet - the vote is only scheduled. Linger here "
                + "10s and it opens on its own, which is step 3.",
            run: () => {
                ConInfoFormTester.setRoster(3);
                ConInfoFormTester.reopenScreen(() => ConInfoFormTester.setStatus("player2", "dropped"));
            },
        },
        {
            title: "10s later, the vote opens",
            watch: "The Vote column appears with Kick / Wait buttons on player2's row only. "
                + "A drop that resolves before this point never shows a vote at all.",
            run: () => {
                ConInfoFormTester.setRoster(3);
                ConInfoFormTester.reopenScreen(() => {
                    ConInfoFormTester.setStatus("player2", "dropped");
                    ConInfoFormTester.pendingVoteOpenAt.delete("player2");
                    ConInfoFormTester.openVote("player2");
                });
            },
        },
        {
            title: "player3 votes wait",
            watch: "One extension is spent, so player2's countdown jumps by 30s and the "
                + "pool drops to 1. A kick can no longer carry while that veto stands.",
            run: () => {
                ConInfoFormTester.setRoster(3);
                ConInfoFormTester.reopenScreen(() => {
                    ConInfoFormTester.setStatus("player2", "dropped");
                    ConInfoFormTester.pendingVoteOpenAt.delete("player2");
                    ConInfoFormTester.openVote("player2");
                    ConInfoFormTester.castVote("player3", "player2", "wait");
                });
            },
        },
        {
            title: "you vote kick - and it is final",
            watch: "Your buttons are replaced by your choice plus the running count. "
                + "There is nothing left to click: the vote cannot be changed.",
            run: () => {
                ConInfoFormTester.setRoster(3);
                ConInfoFormTester.reopenScreen(() => {
                    ConInfoFormTester.setStatus("player2", "dropped");
                    ConInfoFormTester.pendingVoteOpenAt.delete("player2");
                    ConInfoFormTester.openVote("player2");
                    ConInfoFormTester.castVote("player3", "player2", "wait");
                    ConInfoFormTester.castVote(ConInfoFormTester.localName, "player2", "kick");
                });
            },
        },
        {
            title: "4 players, both extensions spent",
            watch: "Two different players voting wait drains the pool to 0. Wait is now "
                + "advisory, so the Wait button is disabled and a kick majority would carry.",
            run: () => {
                ConInfoFormTester.setRoster(4);
                ConInfoFormTester.reopenScreen(() => {
                    ConInfoFormTester.setStatus("player2", "dropped");
                    ConInfoFormTester.pendingVoteOpenAt.delete("player2");
                    ConInfoFormTester.openVote("player2");
                    for (const player of ConInfoFormTester.players) {
                        if (ConInfoFormTester.isEligibleVoter(player.name, "player2")) {
                            ConInfoFormTester.castVote(player.name, "player2", "wait");
                        }
                    }
                });
            },
        },
        {
            title: "player2 reconnects and replays",
            watch: "Status flips to Rejoining: the countdown is replaced by a progress bar "
                + "filling to 100%, and any vote is closed immediately.",
            run: () => {
                ConInfoFormTester.setRoster(3);
                ConInfoFormTester.reopenScreen(() => ConInfoFormTester.setStatus("player2", "rejoining"));
            },
        },
        {
            title: "2 players - no voting at all",
            watch: "player2 drops but no Vote column ever appears: one remaining player "
                + "must not get to decide another's fate alone.",
            run: () => {
                ConInfoFormTester.setRoster(2);
                ConInfoFormTester.reopenScreen(() => ConInfoFormTester.setStatus("player2", "dropped"));
            },
        },
        {
            title: "watching as an observer",
            watch: "A vote is open, but you get no buttons - the server ignores votes from "
                + "non-required players, so offering them would be a lie.",
            run: () => {
                // setRoster rebuilds every player with isObserver false, so
                // this is also what un-observes you again on any other step.
                ConInfoFormTester.setRoster(4);
                ConInfoFormTester.players[0].isObserver = true;
                ConInfoFormTester.reopenScreen(() => {
                    ConInfoFormTester.setStatus("player2", "dropped");
                    ConInfoFormTester.pendingVoteOpenAt.delete("player2");
                    ConInfoFormTester.openVote("player2");
                });
            },
        },
    ];

    private static gotoWalkStep(index: number): void {
        const step = this.walkthrough[index];
        if (!step) {
            return;
        }
        this.walkStep = index;
        this.log = [];
        this.addLog(`walkthrough ${index + 1}/${this.walkthrough.length}: ${step.title}`);
        step.run();
    }

    // Rebuilds the panel, unless a mouse button is currently held down over it,
    // in which case it waits for the release so the in-flight click survives.
    private static requestPanelRebuild(): void {
        if (this.pointerDown) {
            this.rebuildPending = true;
            return;
        }
        this.renderPanelBody();
    }

    // Repaints just the NOW readout. Deliberately touches nothing else: every
    // other control in the panel must survive untouched between clicks.
    private static renderNowBlock(): void {
        const block = this.nowBlock;
        if (!block) {
            return;
        }
        block.replaceChildren();
        const seconds = (untilMs: number) => Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
        const line = (text: string, dim = true) => {
            const el = document.createElement("div");
            el.textContent = text;
            el.style.cssText = dim ? "opacity:0.75;" : "";
            block.appendChild(el);
        };
        const away = this.players.filter(p => p.status !== "connected");
        if (away.length === 0) {
            line("All " + this.players.length + " players connected. Nothing to see on the screen yet - drop someone in step 2.");
        }
        for (const player of away) {
            if (player.status === "dropped") {
                const pending = this.pendingVoteOpenAt.get(player.name);
                const detail = pending !== undefined
                    ? "vote opens in " + seconds(pending) + "s"
                    : this.sessions.has(player.name) ? "vote OPEN" : "no vote";
                const left = seconds(player.timeoutAt ?? 0);
                line(player.name + ": DROPPED, "
                    + (left > 0 ? left + "s to resign" : "grace expired (server would resign now)")
                    + " - " + detail, false);
            }
            else if (player.status === "rejoining") {
                line(player.name + ": REJOINING, replay " + player.loadPercent + "%", false);
            }
            else {
                line(player.name + ": RESIGNED", false);
            }
        }
        for (const [targetNick, session] of this.sessions) {
            const tally = this.tallyFor(targetNick);
            if (!tally) {
                continue;
            }
            line("  vote on " + targetNick + ": kick " + tally.kickVotes + "/" + tally.majorityThreshold
                + ", wait " + tally.waitVotes
                + ", ext " + session.extensionsRemaining + "/" + VOTE_EXTENSIONS_MAX, false);
            if (tally.waitVotes > 0) {
                line("  " + (session.extensionsRemaining > 0
                    ? "a wait vote is vetoing the kick"
                    : "extensions spent - wait votes are advisory, a kick majority carries"));
            }
        }
    }

    private static renderPanelBody(): void {
        const panel = this.panel;
        if (!panel) {
            return;
        }
        panel.replaceChildren();

        const heading = (text: string) => {
            const el = document.createElement("div");
            el.textContent = text;
            el.style.cssText = "font-weight:bold;margin:10px 0 3px;border-bottom:1px solid rgba(255,184,74,0.3);";
            panel.appendChild(el);
            return el;
        };
        const line = (text: string, dim = true) => {
            const el = document.createElement("div");
            el.textContent = text;
            el.style.cssText = dim ? "opacity:0.75;" : "";
            panel.appendChild(el);
            return el;
        };
        const row = () => {
            const el = document.createElement("div");
            el.style.cssText = "margin:2px 0;display:flex;align-items:center;gap:3px;white-space:nowrap;";
            panel.appendChild(el);
            return el;
        };
        // A control that represents current state is marked, never disabled --
        // a greyed-out button reads as "unavailable", which is the opposite of
        // "this is what you have selected".
        const button = (label: string, onClick: () => void, active = false) => {
            const el = document.createElement("button");
            el.textContent = label;
            el.style.cssText = "margin:0;padding:1px 5px;font:10px monospace;flex:0 0 auto;"
                + (active ? "outline:1px solid #ffd84a;font-weight:bold;" : "");
            el.onclick = () => {
                onClick();
                this.requestPanelRebuild();
            };
            return el;
        };
        // Fixed-width so every player row's buttons start at the same column.
        const rowLabel = (parent: HTMLElement, text: string, color?: string) => {
            const el = document.createElement("span");
            el.textContent = text;
            el.style.cssText = "flex:0 0 108px;overflow:hidden;text-overflow:ellipsis;"
                + (color ? "color:" + color + ";" : "");
            parent.appendChild(el);
        };

        // ---- what is happening right now ----
        heading("NOW");
        // The only part that changes on its own, so it lives in its own
        // container that the ticker repaints in isolation. Repainting the whole
        // panel four times a second destroyed and rebuilt every button, and a
        // rebuild landing between mousedown and mouseup means the two events hit
        // different elements -- so no click event fires at all, and the button
        // appears to need two or three presses.
        this.nowBlock = document.createElement("div");
        // Fixed height: NOW is the one block that changes size on its own (a
        // vote opening adds two lines), and letting it reflow shifts every
        // control below it out from under the cursor mid-click.
        this.nowBlock.style.cssText = "min-height:72px;";
        panel.appendChild(this.nowBlock);
        this.renderNowBlock();

        // ---- 1. setup ----
        heading("1. SETUP");
        line("Voting needs " + VOTE_MIN_REQUIRED_PLAYERS + " required players. Now: " + this.requiredCount() + ".");
        const rosterRow = row();
        rowLabel(rosterRow, "roster");
        for (const count of [2, 3, 4, 5]) {
            rosterRow.appendChild(button(count + "P", () => {
                this.setRoster(count);
                this.reopenScreen();
            }, this.players.length === count));
        }
        const viewRow = row();
        rowLabel(viewRow, "you are");
        for (const player of this.players) {
            viewRow.appendChild(button(player.name, () => {
                this.localName = player.name;
                this.reopenScreen();
            }, this.localName === player.name));
        }
        const obsRow = row();
        rowLabel(obsRow, "your role");
        obsRow.appendChild(button(this.localPlayer().isObserver ? "observer" : "player", () => {
            this.localPlayer().isObserver = !this.localPlayer().isObserver;
            this.reopenScreen();
        }, this.localPlayer().isObserver));
        obsRow.appendChild(document.createTextNode("(observers cannot vote)"));
        line("Changing either reopens the screen. This tool rebroadcasts any open vote so it survives; the real server does not, so a reopened screen stays blank (docs 13.4).");

        // ---- 2. simulate ----
        heading("2. SIMULATE A DISCONNECT");
        line("The vote opens by itself " + VOTE_OPEN_DELAY_MILLIS / 1000 + "s after a drop, as on the server. Reconnecting first cancels it entirely.");
        for (const player of this.players) {
            const playerRow = row();
            rowLabel(playerRow, player.name + (player.name === this.localName ? " (you)" : ""), player.color.asHexString());
            playerRow.appendChild(button("playing", () => this.setStatus(player.name, "connected"), player.status === "connected"));
            playerRow.appendChild(button("drop", () => this.setStatus(player.name, "dropped"), player.status === "dropped"));
            playerRow.appendChild(button("rejoin", () => this.setStatus(player.name, "rejoining"), player.status === "rejoining"));
            playerRow.appendChild(button("resign", () => this.setStatus(player.name, "left"), player.status === "left"));
        }
        for (const [nick] of this.pendingVoteOpenAt) {
            const skipRow = row();
            rowLabel(skipRow, "waiting");
            skipRow.appendChild(button("open " + nick + "'s vote now", () => {
                this.pendingVoteOpenAt.delete(nick);
                this.openVote(nick);
            }));
        }

        // ---- 3. the other players' votes ----
        heading("3. THE OTHER PLAYERS VOTE");
        if (this.sessions.size === 0) {
            line("(no vote open - drop someone and wait)");
        }
        for (const [targetNick, session] of this.sessions) {
            line("on " + targetNick + ":", false);
            let anyVoter = false;
            for (const voter of this.players) {
                if (!this.isEligibleVoter(voter.name, targetNick) || voter.name === this.localName) {
                    continue;
                }
                anyVoter = true;
                const cast = session.votes.get(voter.name);
                const voterRow = row();
                rowLabel(voterRow, "  " + voter.name);
                if (cast) {
                    // Votes are final, so there is nothing left to offer here --
                    // matching what the screen itself shows once you have voted.
                    const done = document.createElement("span");
                    done.textContent = "voted " + cast + " (final)";
                    done.style.cssText = "color:#ffd84a;";
                    voterRow.appendChild(done);
                }
                else {
                    voterRow.appendChild(button("kick", () => this.castVote(voter.name, targetNick, "kick")));
                    voterRow.appendChild(button("wait", () => this.castVote(voter.name, targetNick, "wait")));
                }
            }
            if (!anyVoter) {
                line("  (nobody else is eligible - you are the only voter)");
            }
        }
        line("You vote on the game screen itself, in the Vote column.");

        // ---- 4. guided walkthrough ----
        heading("4. WALKTHROUGH");
        if (this.walkStep < 0) {
            line("Nine steps through the whole feature, in order. Each one sets the situation up and says what to look for.");
        }
        else {
            const step = this.walkthrough[this.walkStep];
            const title = document.createElement("div");
            title.textContent = "Step " + (this.walkStep + 1) + "/" + this.walkthrough.length + ": " + step.title;
            title.style.cssText = "font-weight:bold;color:#ffd84a;margin:2px 0;";
            panel.appendChild(title);
            const watch = document.createElement("div");
            watch.textContent = "Look for: " + step.watch;
            watch.style.cssText = "opacity:0.9;margin-bottom:3px;";
            panel.appendChild(watch);
        }
        const walkRow = row();
        rowLabel(walkRow, "steps");
        walkRow.appendChild(button("< back", () => this.gotoWalkStep(this.walkStep - 1)));
        walkRow.appendChild(button(this.walkStep < 0 ? "start walkthrough" : "next >", () => this.gotoWalkStep(this.walkStep + 1)));
        if (this.walkStep >= 0) {
            walkRow.appendChild(button("exit", () => {
                this.walkStep = -1;
            }));
        }
        const jumpRow = row();
        rowLabel(jumpRow, "jump to");
        for (let i = 0; i < this.walkthrough.length; i++) {
            jumpRow.appendChild(button(String(i + 1), () => this.gotoWalkStep(i), this.walkStep === i));
        }

        heading("LOG");
        for (const entry of this.log) {
            const el = document.createElement("div");
            el.textContent = entry;
            el.style.cssText = "opacity:0.8;font-size:10px;";
            panel.appendChild(el);
        }
        TestToolSupport.applyPanelTheme(panel);
    }

    private static buildHomeButton(parent: HTMLElement): void {
        const homeButton = this.homeButton = document.createElement("button");
        homeButton.innerHTML = "Back to Home";
        homeButton.style.cssText = `
      position: fixed;
      left: 12px;
      top: 12px;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      z-index: 1000;
    `;
        TestToolSupport.applyHomeButtonTheme(homeButton);
        homeButton.onclick = () => {
            window.location.hash = "/";
        };
        parent.appendChild(homeButton);
        this.disposables.add(() => homeButton.remove());
    }

    static destroy(): void {
        TestToolSupport.clearState("coninfo");
        this.disposables.dispose();
        this.disposables = new CompositeDisposable();
        this.homeButton?.remove();
        this.homeButton = undefined;
        this.panel?.remove();
        this.panel = undefined;
        this.nowBlock = undefined;
        this.pointerDown = false;
        this.rebuildPending = false;
        this.controller = undefined;
        this.gservCon = undefined;
        this.sessions.clear();
        this.pendingVoteOpenAt.clear();
        this.log = [];
    }
}
