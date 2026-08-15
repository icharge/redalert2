# Screen Flow & UI Parity — Port vs Upstream

Detailed comparison of the TS port (`src/gui/`) against the JS upstream
(`downloaded-game-js/extracted/`). Covers routing/flow architecture and a
per-screen inventory of buttons, form fields, and interactive components.

Status: review draft. Every delta is listed; deltas marked **[GAP]** are
missing functionality, **[EXTRA]** are port-only additions, **[BUG]** are
broken paths in the port.

---

## 1. Architecture parity

### 1.1 Controller state machine — identical

| Concept | Upstream (`gui__screen__Controller.js`) | Port (`src/gui/screen/Controller.ts`) |
|---|---|---|
| State | `screens: Map<ScreenType, Screen>`, `screenStack`, `_onScreenChange` | same (`:13-18`) |
| `goToScreenBlocking` | resets stack (loops `leaveCurrentScreen`), then `pushScreen` | same (`:26-32`) |
| `goToScreen` | async fire-and-forget wrapper | same (`:36-40`) |
| `pushScreen` | `currentScreen.onStack?.()`, push, `screen.onEnter(params)`, dispatch | same (`:41-60`) |
| `popScreen(params)` | `onLeave()`, then previous screen's `onUnstack?.(params)` | same (`:61-76`) |
| Screen lifecycle | `onEnter / onLeave / onStack / onUnstack / update / destroy` | same (Controller.ts:2-11) |

- **`onUnstack` params hand-back** (MapSel → Skirmish/Lobby returning
  `{gameMode, mapName, changedMapFile}`) works identically on both sides.
- Subclass hierarchy identical: `RootController` (3 root screens + typed
  `createGame`/`joinGame` wrappers), `MainMenuController` (sidebar title,
  `musicType`, button show/hide), `GameMenuController` (HUD sidebar,
  `close()` pops the stack).
- Route carriers identical: `RootRoute {screenType, params}` and
  `MainMenuRoute {screenType, params}`. `afterLogin` dual-dispatch identical:
  `MainMenuRoute` → `controller.goToScreen(...)`, anything else →
  `rootController.goToScreen(...)`.
- `ScreenParamsMap` files are compile-time-only in the upstream too (empty at
  runtime) — the port's empty `gameMenu/ScreenParamsMap.ts` is correct parity.

### 1.2 Entry sequence — deltas

Upstream (`Application.js` `main()`):
1. `SplashScreen` DOM overlay rendered immediately, **minimum 5s** (0 in dev)
2. During splash: `CfTurnstile.load()`, `loadGpuBenchmarkData()`,
   `Engine.setActiveEngine(RedAlert2)`, GameRes bootstrap, rules/strings,
   fonts, `migrateReplayStorage()`
3. `await sleep` → splash `destroy()` → `initRouting()` → `Gui.init()`

Port (`src/Application.ts:440-765`):
- React splash overlay (App.tsx) — no 5s minimum **[EXTRA/GAP mixed]**
- Same bootstrap order minus GPU benchmark and replay-storage migration
  (`loadGpuBenchmarkData` is an `[MVP] Skipping` stub, Application.ts:436-439)

`Gui.init()` differences:

| Feature | Upstream | Port | Status |
|---|---|---|---|
| **Reconnect prompt** | `routeToInitialScreen`: `LastConnection` exists → "Reconnect?" → `goToScreen(Game, storedParams)` | absent | **[GAP]** |
| **GPU-tier prompt** | auto apply low/high graphics preset with confirmation | absent | **[GAP]** |
| **Patch-notes modal** | shown once per new app version (messageBox, not nav) | absent | **[GAP]** |
| Audio-permission prompt | yes | yes | match |
| Replay deep-link entry | `goToScreen(Replay, {replay})` | not routed | **[GAP]** |

### 1.3 Hash routing — deltas

Upstream routes: `/`, `/game` (base64 `RouteHelper.extractGameParams` → join
MP directly), `/replay` (`?replayId=` / `replayUrl`), `*` (destroy app), plus
test routes `/lobbytest /vxltest /shptest /buildtest /vehicletest /airtest
/inftest /soundtest`.

Port routes (Application.ts:792-961): `/` + same test routes plus
`/worldscenetest /unitmovementtest /perftest /scenesandbox /liveinteraction`.
**Missing: `/game` and `/replay`.** Consequence: `ReplaySelScreen.ts:340`
still opens old-client replays via `window.open(...#/replay/<id>)`, which hits
the `*` handler and kills the app **[GAP]**.

---

## 2. Root-level navigation

| Source | Trigger | Target (both sides identical unless noted) |
|---|---|---|
| Boot | `Gui.routeToInitialScreen` | `MainMenuRoot` |
| Skirmish | Start Game | `Game` `{create:true, singlePlayer:true, returnTo: Skirmish}` |
| Lobby host | Start Game | `Game` `{create:true, gservUrl, mapTransfer, returnTo: Login(forceRestoreSession→CustomGame)}` |
| Lobby guest | game start | `Game` `{create:false}` |
| QuickGame | matched | `Game` `{joinGame, tournament:true, returnTo: Login→QuickGame}` |
| GameScreen | MP credentials missing | `MainMenuRoot`→Login, `afterLogin: RootRoute(Game, params)` — **[BUG]** port passes string `'Game'` (GameScreen.ts:149) which fails the `Map<number, Screen>` lookup |
| GameScreen | in-game menu Quit | `MainMenuRoot`→Score `{isQuit:true, returnTo}` |
| GameScreen | game ended | `MainMenuRoot`→Score (5s popup first) |
| GameScreen | fatal error | `goToScreen('MainMenuRoot')` — **[BUG]** string type (GameScreen.ts:483), swallowed → blank screen |
| ReplaySel | Load Replay | `Replay` `{replay}` |
| ReplayScreen | quit/version-mismatch | `MainMenuRoot` (→Home) — same as upstream |

Port-only root navigation: **LAN setup** (`LanSetupScreen.ts:163-175`
`roomSession.onLaunch` → Game with `lanLaunch, lanMatchSession,
lanMapDataBase64, returnTo: LanSetup`).

---

## 3. HomeScreen + sidebar shell

### 3.1 Sidebar shell — identical
`MainMenu` (mnscrnl.shp bg, lwscrnl.shp status bar + `MenuTooltip`,
`SidebarPreview` with `sdwrntmp.shp` open animation, `VersionString`,
`MenuVideo`), slot sprites `sdbtnbkgd/sdbtnanm.shp` + `MenuButton` HTML
overlay, `MenuSlotAnimationRunner` states (Hidden/Unlit/Normal/Active),
MP slot `sdmpbtn.shp` + `MenuMpSlotText`, bottom cap `sdbtm.shp`.

### 3.2 HomeScreen buttons

| Button | Upstream | Port |
|---|---|---|
| Quick Match | `GUI:QuickMatch` → Login→QuickGame; gated `quickMatchEnabled` (real config) | same logic, but wiring hardcodes `quickMatchEnabled=false` (MainMenuRootScreen.ts:465) → never visible **[GAP]** |
| Custom Game | `GUI:CustomMatch` → Login→CustomGame | same |
| Skirmish / Demo | `GUI:Demo` → Skirmish | hardcoded "Skirmish"; stale "Feature Under Development" alert on nav failure (HomeScreen.ts:80) **[BUG-ish]** |
| Replays | `GUI:Replays` → push ReplaySelection | same (hardcoded label) |
| Mods | `pushScreen(ModSelection)` when `storageEnabled` | placeholder alert "under development" (ModSelection unregistered) **[GAP]** |
| Info & Credits | `TS:InfoAndCredits` → push InfoAndCredits | same |
| Options | `GUI:Options` → push Options | same |
| Fullscreen | bottom, disabled when FS unavailable | same |
| Live Interaction | — | **[EXTRA]** hash to `/liveinteraction` (tears down GUI) |
| LAN Multiplayer | — | **[EXTRA]** push LanSetup |
| Test Entry | — | **[EXTRA]** push TestEntry |

Label note: port hardcodes several English labels (Skirmish, Live
Interaction, Replays, LAN Multiplayer, Test Entry) instead of string-table
keys — parity nit.

### 3.3 PrefetchProgress
`PrefetchProgress.tsx` implemented but **not wired** in port's
`MainMenuRootScreen` (upstream shows it ~20s after menu entry during CDN
prefetch) **[GAP]**.

---

## 4. Skirmish + LobbyForm (shared component)

### 4.1 Form fields — identical
- Slot table headers: Players / Side / Color / Start Position / Team
- Player slot select: occupied name / Open / OpenObserver / Closed-or-None /
  AI difficulties (`GUI:AIDummy` Easy, `GUI:AIEasyBeta` Medium; port adds
  per-AI tooltips)
- Host slot: read-only text input; status icons `wolhost.pcx` (host) /
  `wolacpt.pcx` (ready); RankIndicator, PingIndicator (MP)
- CountrySelect (flag + tooltip, Random/Observer), ColorSelect (hidden for
  observers), StartPosSelect (numbers + Random), TeamSelect (None + A–D,
  Observer option)
- Checkboxes (disabled for guests): Short Game, MCV Repacks, Crates Appear,
  Super Weapons Allowed, Host Teams (prop-gated), Destroyable Bridges, Multi
  Engineer, Instant Capture (forced checked + disabled when Multi Engineer),
  No Dog Engi Kills, Delayed Oils
- Sliders: Game Speed 0–6, Credits (`minMoney..maxMoney`, step
  `moneyIncrement`), Unit Count; Build Off Ally checkbox
- Chat only when `messages`+`localUsername`+`onSendMessage` supplied (MP)
- Hidden game-server select (`TS:ServerLabel`) when `selectedGameServer`
- Map preview (`MapPreviewRenderer`): numbered yellow start positions,
  per-lobby tooltip

### 4.2 SkirmishScreen deltas

| Item | Upstream | Port |
|---|---|---|
| Start Game | `createSpGame("0", Date.now(), playerName, ...)` — profile player name | `createGame('0', ..., singlePlayer:true)` with player name **hardcoded `'Player 1'`** (SkirmishScreen.ts:76) |
| Upload AI Bot | — | **[EXTRA]** `GUI:BotUpload` button + raw-DOM dialog (`.zip` input, Manage Bots w/ Remove, OK), bots persisted `StorageKey.UploadedBots` (SkirmishScreen.ts:337-414) |

Form-model defaults identical (`PreferredHostOpts`: speed 6 / 10000 cr / 10
units / shortGame on / superWeapons off / buildOffAlly on / mcvRepacks on /
crates off / hostTeams off / destroyableBridges on / multiEngineer off /
instantCapture on / delayedOils off; Skirmish `initFormModel` overrides
superWeapons=true).

---

## 5. Login / NewAccount / Realm / Nickname — identical

- Login sidebar: `GUI:Login` (disabled: region unavailable OR turnstile
  without token), `GUI:NewAccount` (disabled unless legacy registration OR
  providers), `GUI:Back`.
- LoginBox: Region `ServerList` (Online/Offline text, click select,
  double-click submit, refresh icon button) — Nickname (required,
  `minLength=MIN_USERNAME_LEN`, `maxLength`, pattern `[a-zA-Z0-9_\-]+`,
  autofocus) — Password (required, max) — Turnstile (action "login", or
  `TS:TurnstileLoadFailed`) — hidden submit — `AuthProviderButtons`
  (Discord, popup auth / `window.location.assign`) — `LoginDebugUi` (devMode:
  8 test users, `testpass`) — `BreakingNews` fieldset.
- Flows identical: auto session-restore, queue-position modal
  (`TS:ServerFull`, position, avg wait, Cancel), `NicknameClaimPrompt` +
  Skip For Now, error texts (`TXT_BADPASS`, banned, outdated client).
- NewAccount: `GUI:Ok` gated on `legacyRegistrationEnabled` + turnstile
  token; region select (hidden input when 1 region); Nickname/Password/Re-
  enter; turnstile "register"; `AuthProviderButtons` standalone.
- RealmSelection: Continue (disabled busy/unavailable), Logout, Back;
  auto-continue on preferred nickname+realm match.
- NicknameSelection: Login, New Nickname (messageBox prompt), Link Nickname
  (`NicknameClaimCredentialsPrompt` OK/Cancel + username/password/turnstile),
  Back→RealmSelection; auto-login checkbox, capacity text.

No deltas found in this screen group.

---

## 6. QuickGame

Buttons — identical set: Play (`GUI:QuickMatchPlay`, disabled while queued,
flashing when teammate ready, `joinQueue`), Leave Party (gated `partyId`),
View Ladder (gated `wladderService.getUrl()`), View Rules (gated LadderRules
screen registered — dead in port **[GAP]**: `QuickGameScreen.ts:628-633`
never shows since LadderRules is never registered), Logout (→
NicknameSelection or Login), Main Menu/Cancel (`isBottom`, label switches on
queue state).

Form — identical: mode `ButtonSelect` (1v1/2v2, disabled when `partySize===2`
&& Solo1v1), Ranked/Unranked (Unranked gated `unrankedEnabled`), Preferred
Country/Color (disabled in queue), party list / Invite Player →
`SendPartyInviteDialog` (text input + `RecentPlayersList`), PartyNoInvites
checkbox, profile panel (rank icon + name + number, promo progress ▲/▼,
wins/points/bonus pool/MMR + info tooltip).

Chat — identical: `#Lob <id> 0` channel, users list (operators first),
per-user menu Message/Invite-to-Team (disabled in queue).

PartyInviteDialog — identical: Accept/Decline, "prevent future invites"
checkbox after a prior decline, 30s timeout.

---

## 7. CustomGame (GameBrowser)

| Item | Upstream | Port |
|---|---|---|
| Create Game | `GUI:CreateGame` → Lobby `{create:true}` | same |
| Join Game | disabled when no selection/full; mod-hash mismatch → `TXT_MISMATCH` system message | same |
| Observe | disabled unless observable && no observers | same |
| Logout | → NicknameSelection/Login | **missing** **[GAP]** |
| Change Server | — | **[EXTRA]** only when `serverRegions.getSize() > 1` → Login `{clearCredentials}` |
| Back / Main Menu | `isBottom`, closes WOL → Home | same (labeled Back) |

Game list — identical: refresh icon button, columns Map / Room Desc / 👤
(`n/m`, `?/?`) / Host Name + RankIndicator / Ping `<meter max=300>`; flags
(`woltrny` tournament, `gt18` official, `settings.png` custom/mod, `wolpriv`
private, `wolob` observable); row tooltip (mod/map/ping/host rank);
double-click joins; 5s refresh; chat + user list (whisper menu).

---

## 8. Lobby (host/guest) — identical

- Host: Start Game (disabled while `startGamePending`; validation chain:
  no-map warning `GUI:HostNoMap`, <2 non-observer → `TXT_ONLY_ONE`, teams →
  `TXT_CANNOT_ALLY`, unready → `GUI:HostGameStartHost` + `sendGameStartRequest`,
  pending modal `wol:matchgamestarting`), Choose Map, Back → CustomGame.
- Guest: Accept / Not Ready (disabled when own map status NoMap; flashing on
  host start request).
- Dialogs: `CreateGameBox` (Room Desc `maxLength=Serializer.MAX_ROOM_DESC_LEN`,
  Password enable-checkbox + input, Observe checkbox, OK/Cancel),
  `PasswordBox` (single password, OK/Cancel).
- Guest map-availability system: HasMap / MapTransfer / NoMap with
  `GUI:HostMapTransfer / HostNoMap / HostNoMapUpload / JoinerMapTransfer /
  JoinerNoMap`.
- MP slot: mode + map title + icon (`gt18` verified / `settings.png`
  unverified), tooltips `STT:VerifiedMap / UnverifiedMap`.
- Timing: 5s host-options broadcast, 30s gserv ping.

---

## 9. MapSel / ReplaySel / Ladder — identical

- MapSel: Use Map (MapSupport check; `GUI:EjectPlayers` confirm when used
  slots > maxSlots; `popScreen({gameMode, mapName, changedMapFile})`), Import
  Map (gated `mapDir`; duplicate/unsupported-triggers/game-mode/type/quota
  checks), Cancel. Component: game-type list, map list (double-click
  submits, auto-scroll), sort select (None/Name↑↓/MaxSlots↑↓, persisted
  `LastSortMap`), search input.
- ReplaySel: Load Replay (version-mismatch → old-client confirm, mod
  mismatch), Keep/Rename (`KeepReplayBox` name prompt), Import (hidden file
  input), Export (blob download), Delete (confirm), Back→popScreen.
  `ReplayDetailsPane` (time/version/gameId/map/players/duration),
  `StorageWarning` (<1MB free).
- Ladder: season select (>1 season), ladder select (division + disabled
  ranked-players row), search form (placeholder `GUI:Player` + Search),
  type list (season info / 1v1 / 2v2random), season-info pane
  (top-tier start / demotions / promotions / lock date), table (# / rank /
  name link to external leaderboard when current season / points & MMR
  columns data-dependent / wins / losses), pagination `<< < > >>`.

---

## 10. Score

| Item | Upstream | Port |
|---|---|---|
| Continue button | `GUI:Continue` → `returnTo` | same |
| Background | GDI `mpascrnl`, Nod `mpsscrnl`, **ThirdSide `mpyscrnl`** | only GDI/Nod **[GAP]** |
| Donate prompt | on leave when `config.donateUrl`: Donate Now/Later, max 2 shows + weekly cooldown, `gtag` | absent **[GAP]** |
| ScoreTable | result title victory/draw/defeat, waiting, points +N, columns country/rank/player/MMR(tournament)/kills/losses/built/score, rows colorized | same |

---

## 11. Options

| Fieldset | Upstream | Port |
|---|---|---|
| Gameplay | Scroll Rate slider 1–7 (×3 factor), Mouse Accel On/Off + tooltip, Attack Move Left/Right, Right Click Scroll, Flyer Label Always/Selected/Never, Show Hidden, Target Lines | same 7 + **Joystick checkbox** (mobile/coarse-pointer only, persisted `ra2web.mobileJoystickLite.enabled`) **[EXTRA]** |
| Graphics | Resolution (fullscreen: disabled option; else Fit-to-window + presets ≤ screen), Models High/Low (disabled in-game), Shadows High/Medium/Low/Off | identical |
| Performance | — | **[EXTRA]** port-only fieldset: 6 checkboxes — Raycast Helper Reuse, Entity Intersect Traversal, Map Tile Hit Test, World Viewport Cache, World Sound Loop Cache, Telemetry & Benchmarks |
| Sound | 7 volume sliders (Master/Music/SFX/Voice/Ambient/UI/Credits) + Jukebox (Shuffle, Repeat, playlist, Play, Stop) | identical |
| Keyboard | `configurableCmds` (~80), Description panel, Current Shortcut, PressKeyInput (rejects Esc/arrows/Space/FS hotkey), Assign (modifier-conflict errors), Reset All, `TS:HotKeyFSWarning` | identical |
| Storage | full explorer via external lib: upload (1 concurrent, protected paths, overwrite Yes/YesToAll/No/Cancel), new folder (mods dir only, `[a-z0-9-_]+`), delete (system-file confirm), download + ZIP export, quota bar, Exit and Reload | port reimplements similar (`StorageFileExplorer`, upload whitelist incl. `keyboard.ini / *.mix / music/*.mp3 / replays/* / taunts/tau*.wav / mods/* / maps/*`), but **[GAP]** error UI is a minimal hardcoded "Storage Error / No storage directory handle" panel (StorageScreen.ts:46-60) |

---

## 12. In-game menu + HUD

- GameMenuHome: Options, Fullscreen, Abort Mission, Resume Mission
  (`onCancel`); backdrop `bkgd<lg|md|sm>.shp` + 75% black mask. — identical.
- QuitConfirm: Quit, Observe (gated `observeAllowed`), Resume Mission. —
  identical.
- DiploForm: table (country / ping / player / allies / chat(MP) / kills),
  Allies checkboxes (semi-checked pending states; gated
  `alliancesAllowed = MP && alliesAllowed && allyChangeAllowed`), mute
  checkboxes (MP), Taunts checkbox (MP, gated), settings summary line, Chat
  All/Team, 2×/s refresh. — identical.
- ConInfoForm: ping `<meter max=1000 low=150 high=500>`, time-allowed
  countdown (starts 52s), initial "Connecting to players…" + reconnect help,
  Abort Mission → QuitConfirm, 1s poll. — identical.
- HUD (upstream inventory; port assumed equal — spot-check if needed):
  diplo/options buttons, repair/sell toggles, 4 sidebar tabs, page
  up/down, command bar from `commandButtonConfigs` (BugReport/Team/TypeSelect/
  Deploy/Guard/Beacon/Stop/Planning/Cheer/Replay controls), cameo slots
  (`agg_cameos.shp`, gclock2 progress, READY/HOLD, quantity badge, tooltip),
  SidebarCredits counter, SidebarGameTime, SidebarPower pips, SidebarRadar
  cover, SuperWeaponTimers stack, Messages canvas + HudChat input,
  GameResultPopup, DebugText.

---

## 13. Stub parity (empty in both)

Upstream empty modules — the port's empty `gameMenu/ScreenParamsMap.ts` is
correct parity, not a bug:

- `gui__screen__ScreenParamsMap.js` / `mainMenu__ScreenParamsMap.js` /
  `game__gameMenu__ScreenParamsMap.js`
- `gui__screen__mainMenu__component__viewmodel__MenuButtonConfig.js`
- `gui__screen__mainMenu__lobby__SelectMapParams.js`
- `gui__screen__mainMenu__customGame__component__viewmodel__gameBrowser.js`
- `gui__screen__game__component__hud__commandBar__CommandButtonConfig.js`
- `game__gameopts__constants.js` `aiUiTooltips` is empty upstream (AI
  tooltips not wired there; port does provide them)

---

## 14. Delta summary

### Gaps (missing in port)
1. `routeToInitialScreen` reconnect prompt (LastConnection → Game)
2. GPU-tier auto-preset prompt
3. Patch-notes modal on new version
4. `/game` and `/replay` deep-link routes (replay popup link broken)
5. Home Quick Match unreachable — hardcoded `quickMatchEnabled=false`
6. ModSelection / PatchNotes / LadderRules never registered → "View Rules"
   button dead, Mods button placeholder, no patch notes entry
7. CustomGame Logout button
8. InfoAndCredits Patch Notes / Report Bug / Donate buttons (`ReportBug.tsx`
   unused)
9. Score donate prompt + ThirdSide (Yuri) score background
10. `PrefetchProgress` CDN overlay unwired
11. Storage screen minimal error UI vs upstream quota/explorer polish

### Bugs (port)
- `GameScreen.ts:483` `goToScreen('MainMenuRoot')` — string type vs
  `Map<number, Screen>` → swallowed throw, blank screen after fatal game error
- `GameScreen.ts:149` `new RootRoute('Game', ...)` — string type → "log in
  mid-match then continue" flow broken
- `MainMenuRootScreen.ts:465` hardcoded `storageEnabled=false,
  quickMatchEnabled=false` ignoring `Config.quickMatchEnabled`

### Port extras
- AI bot upload (Skirmish), LAN Multiplayer (QR SDP exchange), Live
  Interaction / Test Entry tools, Performance options fieldset, mobile
  Joystick option, CustomGame Change Server button

### Note
- Replay exit → Home is NOT a bug (upstream does the same).
- Skirmish player name hardcoded `'Player 1'` vs upstream profile name.

---

## 15. Reference index

- Controller: `src/gui/screen/Controller.ts`, upstream `gui__screen__Controller.js`
- Root: `src/gui/screen/RootController.ts`, `RootRoute.ts`, `ScreenType.ts`
- Bootstrap: `src/Application.ts:440-765`, `src/Gui.ts:94-408`; upstream
  `Application.js main/initRouting`, `Gui.js init/routeToInitialScreen`
- Home: `src/gui/screen/mainMenu/main/HomeScreen.ts`
- Sidebar shell: `src/gui/screen/mainMenu/component/*` + `src/gui/component/MenuButton.tsx`
- Lobby form: `src/gui/screen/mainMenu/lobby/component/LobbyForm.tsx` (+
  `CreateGameBox`, `PasswordBox`, `PreferredHostOpts`, `MapPreviewRenderer`)
- Login: `src/gui/screen/mainMenu/login/*`, `realmSelection/*`,
  `nicknameSelection/*`
- QuickGame: `src/gui/screen/mainMenu/quickGame/*`
- CustomGame: `src/gui/screen/mainMenu/customGame/*`
- Lobby: `src/gui/screen/mainMenu/lobby/LobbyScreen.ts`
- MapSel: `src/gui/screen/mainMenu/mapSel/*`
- Replays: `src/gui/screen/replay/*`
- Options: `src/gui/screen/options/*`
- Game menu: `src/gui/screen/game/gameMenu/*`
- Upstream mirror: `downloaded-game-js/extracted/gui__screen__*`
