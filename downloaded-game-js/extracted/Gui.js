System.register(
  "Gui",
  [
    "react",
    "engine/Engine",
    "engine/EngineType",
    "gui/UiScene",
    "engine/gfx/Renderer",
    "game/rules/Rules",
    "gui/screen/RootController",
    "gui/screen/mainMenu/MainMenuRootScreen",
    "gui/screen/game/GameScreen",
    "gui/screen/game/gameMenu/ScreenType",
    "gui/screen/mainMenu/ScreenType",
    "gui/screen/ScreenType",
    "gui/component/MessageBoxApi",
    "network/WolConnection",
    "network/GservConnection",
    "network/gameopt/Parser",
    "network/gameopt/Serializer",
    "engine/ResourceLoader",
    "ErrorHandler",
    "engine/UiAnimationLoop",
    "util/Logger",
    "tools/DevToolsApi",
    "gui/jsx/JsxRenderer",
    "gui/Pointer",
    "engine/sound/Sound",
    "engine/sound/AudioSystem",
    "engine/sound/Mixer",
    "engine/sound/SoundSpecs",
    "engine/sound/ChannelType",
    "LocalPrefs",
    "gui/screen/game/worldInteraction/keyboard/KeyBinds",
    "gui/ReplayManager",
    "gui/screen/replay/ReplayScreen",
    "data/vfs/FileNotFoundError",
    "engine/sound/Music",
    "engine/sound/MusicSpecs",
    "gui/screen/game/GameLoader",
    "util/BoxedVar",
    "engine/renderable/builder/vxlGeometry/VxlGeometryPool",
    "engine/gfx/geometry/VxlGeometryCache",
    "engine/gfx/RendererError",
    "gui/replay/ReplayStorageFileSystem",
    "gui/replay/ReplayStorageMemStorage",
    "network/gamestate/Replay",
    "data/vfs/StorageQuotaError",
    "gui/CanvasMetrics",
    "data/vfs/IOError",
    "util/disposable/CompositeDisposable",
    "gui/component/ToastApi",
    "network/WolService",
    "gui/screen/mainMenu/main/HomeScreen",
    "gui/screen/mainMenu/login/AuthPopupApi",
    "gui/screen/mainMenu/lobby/SkirmishScreen",
    "gui/screen/mainMenu/login/LoginScreen",
    "gui/screen/mainMenu/newAccount/NewAccountScreen",
    "gui/screen/mainMenu/nicknameSelection/NicknameSelectionScreen",
    "gui/screen/mainMenu/realmSelection/RealmSelectionScreen",
    "gui/screen/mainMenu/customGame/CustomGameScreen",
    "gui/screen/mainMenu/lobby/LobbyScreen",
    "gui/screen/mainMenu/mapSel/MapSelScreen",
    "gui/screen/replay/ReplaySelScreen",
    "gui/screen/mainMenu/score/ScoreScreen",
    "gui/screen/mainMenu/infoAndCredits/InfoAndCreditsScreen",
    "gui/screen/mainMenu/credits/CreditsScreen",
    "gui/screen/options/OptionsScreen",
    "gui/screen/options/SoundOptsScreen",
    "gui/screen/options/KeyboardScreen",
    "gui/screen/options/StorageScreen",
    "gui/screen/mainMenu/patchNotes/PatchNotesScreen",
    "gui/screen/game/gameMenu/GameMenuHomeScreen",
    "gui/screen/game/gameMenu/DiploScreen",
    "gui/screen/game/gameMenu/ConnectionInfoScreen",
    "gui/screen/game/gameMenu/QuitConfirmScreen",
    "gui/screen/game/loadingScreen/LoadingScreenApiFactory",
    "gui/screen/game/MapFileLoader",
    "gui/screen/mainMenu/modSel/ModSelScreen",
    "gui/screen/mainMenu/modSel/ModManager",
    "gui/screen/mainMenu/quickGame/QuickGameScreen",
    "network/ladder/WLadderService",
    "gui/screen/mainMenu/ladder/LadderScreen",
    "network/WolConfig",
    "gui/screen/mainMenu/ladderRules/LadderRulesScreen",
    "ClientApi",
    "network/WGameResService",
    "network/MapTransferService",
    "util/string",
    "RouteHelper",
    "worker/workerHost",
    "network/CfChallengeHttpRequest",
    "gui/CfPreclearanceApi",
    "network/HttpRequest",
    "network/AuthService",
    "network/RealmService",
    "network/SessionService",
  ],
  function (e, t) {
    "use strict";
    var p,
      q,
      $,
      Q,
      o,
      Y,
      Z,
      X,
      J,
      ee,
      te,
      ie,
      re,
      se,
      ne,
      ae,
      oe,
      le,
      ce,
      l,
      he,
      c,
      ue,
      de,
      h,
      u,
      d,
      g,
      m,
      ge,
      pe,
      me,
      fe,
      ye,
      f,
      y,
      Te,
      ve,
      be,
      Se,
      we,
      Ce,
      Ee,
      T,
      xe,
      Oe,
      Ae,
      v,
      Me,
      Re,
      Pe,
      Ie,
      ke,
      Be,
      Ne,
      Le,
      je,
      De,
      Fe,
      _e,
      Ue,
      He,
      Ge,
      Ve,
      We,
      ze,
      Ke,
      qe,
      $e,
      Qe,
      Ye,
      Ze,
      Xe,
      Je,
      et,
      tt,
      it,
      rt,
      st,
      nt,
      at,
      ot,
      lt,
      ct,
      ht,
      b,
      S,
      ut,
      dt,
      gt,
      pt,
      mt,
      ft,
      yt,
      i;
    t && t.id;
    return {
      setters: [
        function (e) {
          p = e;
        },
        function (e) {
          q = e;
        },
        function (e) {
          $ = e;
        },
        function (e) {
          Q = e;
        },
        function (e) {
          o = e;
        },
        function (e) {
          Y = e;
        },
        function (e) {
          Z = e;
        },
        function (e) {
          X = e;
        },
        function (e) {
          J = e;
        },
        function (e) {
          ee = e;
        },
        function (e) {
          te = e;
        },
        function (e) {
          ie = e;
        },
        function (e) {
          re = e;
        },
        function (e) {
          se = e;
        },
        function (e) {
          ne = e;
        },
        function (e) {
          ae = e;
        },
        function (e) {
          oe = e;
        },
        function (e) {
          le = e;
        },
        function (e) {
          ce = e;
        },
        function (e) {
          l = e;
        },
        function (e) {
          he = e;
        },
        function (e) {
          c = e;
        },
        function (e) {
          ue = e;
        },
        function (e) {
          de = e;
        },
        function (e) {
          h = e;
        },
        function (e) {
          u = e;
        },
        function (e) {
          d = e;
        },
        function (e) {
          g = e;
        },
        function (e) {
          m = e;
        },
        function (e) {
          ge = e;
        },
        function (e) {
          pe = e;
        },
        function (e) {
          me = e;
        },
        function (e) {
          fe = e;
        },
        function (e) {
          ye = e;
        },
        function (e) {
          f = e;
        },
        function (e) {
          y = e;
        },
        function (e) {
          Te = e;
        },
        function (e) {
          ve = e;
        },
        function (e) {
          be = e;
        },
        function (e) {
          Se = e;
        },
        function (e) {
          we = e;
        },
        function (e) {
          Ce = e;
        },
        function (e) {
          Ee = e;
        },
        function (e) {
          T = e;
        },
        function (e) {
          xe = e;
        },
        function (e) {
          Oe = e;
        },
        function (e) {
          Ae = e;
        },
        function (e) {
          v = e;
        },
        function (e) {
          Me = e;
        },
        function (e) {
          Re = e;
        },
        function (e) {
          Pe = e;
        },
        function (e) {
          Ie = e;
        },
        function (e) {
          ke = e;
        },
        function (e) {
          Be = e;
        },
        function (e) {
          Ne = e;
        },
        function (e) {
          Le = e;
        },
        function (e) {
          je = e;
        },
        function (e) {
          De = e;
        },
        function (e) {
          Fe = e;
        },
        function (e) {
          _e = e;
        },
        function (e) {
          Ue = e;
        },
        function (e) {
          He = e;
        },
        function (e) {
          Ge = e;
        },
        function (e) {
          Ve = e;
        },
        function (e) {
          We = e;
        },
        function (e) {
          ze = e;
        },
        function (e) {
          Ke = e;
        },
        function (e) {
          qe = e;
        },
        function (e) {
          $e = e;
        },
        function (e) {
          Qe = e;
        },
        function (e) {
          Ye = e;
        },
        function (e) {
          Ze = e;
        },
        function (e) {
          Xe = e;
        },
        function (e) {
          Je = e;
        },
        function (e) {
          et = e;
        },
        function (e) {
          tt = e;
        },
        function (e) {
          it = e;
        },
        function (e) {
          rt = e;
        },
        function (e) {
          st = e;
        },
        function (e) {
          nt = e;
        },
        function (e) {
          at = e;
        },
        function (e) {
          ot = e;
        },
        function (e) {
          lt = e;
        },
        function (e) {
          ct = e;
        },
        function (e) {
          ht = e;
        },
        function (e) {
          b = e;
        },
        function (e) {
          S = e;
        },
        function (e) {
          ut = e;
        },
        function (e) {
          dt = e;
        },
        function (e) {
          gt = e;
        },
        function (e) {
          pt = e;
        },
        function (e) {
          mt = e;
        },
        function (e) {
          ft = e;
        },
        function (e) {
          yt = e;
        },
      ],
      execute: function () {
        e(
          "Gui",
          (i = class {
            constructor(e, t, i, r, s, n, a, o, l, c, h, u, d, g, p, m, f, y) {
              ((this.appVersion = e),
                (this.appLocale = t),
                (this.engineVersion = i),
                (this.engineModHash = r),
                (this.gpuTier = s),
                (this.config = n),
                (this.gameResConfig = a),
                (this.appResPath = o),
                (this.localPrefs = l),
                (this.generalOptions = c),
                (this.rootEl = h),
                (this.viewport = u),
                (this.fullScreen = d),
                (this.strings = g),
                (this.cdnResourceLoader = p),
                (this.runtimeVars = m),
                (this.sentry = f),
                (this.cfTurnstile = y),
                (this.disposables = new v.CompositeDisposable()),
                (this.handleFullScreenChange = (e) => {
                  e && this.pointer?.getUserLockMode() && this.pointer.lock();
                }),
                (this.handleViewportChange = (e) => {
                  var t;
                  (this.renderer?.setViewportSize(e.width, e.height),
                    this.uiScene &&
                      ((t = Q.UiScene.createCamera(this.viewport.value)),
                      this.uiScene.setCamera(t),
                      this.uiScene.setViewport(this.viewport.value),
                      this.jsxRenderer?.setCamera(t),
                      this.messageBoxApi?.updateViewport(this.viewport.value),
                      this.rootController?.rerenderCurrentScreen(),
                      this.canvasMetrics?.notifyViewportChange()));
                }));
            }
            getRootController() {
              if (!this.rootController)
                throw new Error("Root controller is not initialized");
              return this.rootController;
            }
            async init(e) {
              let t = this.strings,
                i,
                r;
              try {
                ({ renderer: i, uiAnimationLoop: r } = this.initRenderer(
                  this.rootEl,
                  this.viewport.value,
                  this.config.devMode,
                ));
              } catch (e) {
                if (e instanceof we.RendererError)
                  return (
                    console.error(e.cause),
                    void alert(t.get("TS:RendererInitError"))
                  );
                throw e;
              }
              ((this.renderer = i),
                this.viewport.onChange.subscribe(this.handleViewportChange),
                this.disposables.add(() =>
                  this.viewport.onChange.unsubscribe(this.handleViewportChange),
                ),
                this.fullScreen.onChange.subscribe(this.handleFullScreenChange),
                this.disposables.add(() =>
                  this.fullScreen.onChange.unsubscribe(
                    this.handleFullScreenChange,
                  ),
                ));
              var s = this.gameResConfig;
              let n = Q.UiScene.factory(this.viewport.value),
                a = (this.canvasMetrics = new Oe.CanvasMetrics(
                  i.getCanvas(),
                  window,
                ));
              (a.init(), this.disposables.add(a));
              let o = (this.pointer = de.Pointer.factory(
                q.Engine.getImages().get(
                  q.Engine.getActiveEngine() === $.EngineType.YurisRevenge
                    ? "mouse.sha"
                    : "mouse.shp",
                ),
                q.Engine.getPalettes().get("mousepal.pal"),
                i,
                document,
                a,
                this.generalOptions.mouseAcceleration,
              ));
              (o.init(), this.disposables.add(o), n.add(o.getSprite()));
              var l = (this.jsxRenderer = new ue.JsxRenderer(
                q.Engine.getImages(),
                q.Engine.getPalettes(),
                n.camera,
                o.pointerEvents,
              ));
              ((this.toastApi = new Me.ToastApi(this.viewport, n, l)),
                this.disposables.add(this.toastApi),
                (this.messageBoxApi = new re.MessageBoxApi(
                  this.viewport.value,
                  n,
                  l,
                )));
              var c = new ce.ErrorHandler(this.messageBoxApi, t),
                h = new ae.Parser(),
                u = new oe.Serializer();
              let d = (this.rootController = new Z.RootController());
              var g = q.Engine.getMpModes(),
                p = q.Engine.getFileNameVariant("keyboard.ini");
              let m = new pe.KeyBinds(
                q.Engine.rfs?.getRootDirectory(),
                p,
                q.Engine.getIni(p),
              );
              await m.load();
              var f = await q.Engine.getReplayDir().catch((e) => {
                  (console.error("Couldn't get replay directory", [e]),
                    e instanceof xe.StorageQuotaError ||
                      e instanceof Ae.IOError ||
                      e instanceof ye.FileNotFoundError ||
                      this.sentry?.captureException(
                        new Error(`Couldn't get replay directory (${e.name})`, {
                          cause: e,
                        }),
                      ));
                }),
                y = f
                  ? new Ce.ReplayStorageFileSystem(f, this.sentry)
                  : new Ee.ReplayStorageMemStorage(),
                T = new me.ReplayManager(y);
              let v = this.generalOptions;
              var b = new le.ResourceLoader(this.config.mapsBaseUrl),
                S = new le.ResourceLoader(this.appResPath),
                w = new le.ResourceLoader(this.config.modsBaseUrl),
                C = new et.MapFileLoader(b, q.Engine.vfs),
                E = he.AppLogger.get("wol");
              let x = at.WolConfig.factory(
                q.Engine.getActiveEngine() === $.EngineType.YurisRevenge
                  ? at.ClientType.Cdyuri
                  : at.ClientType.Cdral2,
              );
              var O = se.WolConnection.factory(E);
              let A =
                this.cfTurnstile.isLoaded() &&
                this.config.turnstile?.preClearanceEnabled
                  ? new gt.CfPreclearanceApi(
                      this.cfTurnstile,
                      this.messageBoxApi,
                      t,
                    )
                  : void 0;
              var M = A
                ? new dt.CfChallengeHttpRequest(() => A.preClearance())
                : new pt.HttpRequest();
              let R = new Re.WolService(
                x,
                O,
                this.appVersion,
                this.appLocale,
                M,
              );
              (R.init(), this.disposables.add(R));
              var P = new st.WLadderService(x, M),
                I = new ct.WGameResService(R, x, M);
              this.disposables.add(I);
              var k = new ht.MapTransferService(R, M);
              let B, N;
              this.config.gateway &&
                ((B = new mt.AuthService(this.config.gateway, M)),
                (N = new ft.RealmService(
                  this.config.gateway,
                  x.getClientSku(),
                  this.appVersion,
                  this.appLocale,
                  B,
                  M,
                )));
              var L = new yt.SessionService(R),
                j = he.AppLogger.get("gserv"),
                D = ne.GservConnection.factory(j),
                F = q.Engine.getMapList(),
                _ = await q.Engine.getModDir().catch((e) => {
                  (console.error("Couldn't get mods directory", [e]),
                    e instanceof xe.StorageQuotaError ||
                      e instanceof Ae.IOError ||
                      e instanceof ye.FileNotFoundError ||
                      this.sentry?.captureException(
                        new Error(`Couldn't get mods directory (${e.name})`, {
                          cause: e,
                        }),
                      ));
                });
              let U = _ ? new it.ModManager(window.location, _, S) : void 0;
              var H = q.Engine.getActiveMod(),
                p = H ? await U?.loadModMeta(H) : void 0,
                f = await q.Engine.getMapDir().catch((e) => {
                  console.error("Couldn't get map dir", [e]);
                }),
                y = he.AppLogger.get("ini");
              let G;
              try {
                G = new Y.Rules(q.Engine.getRules(), y);
              } catch (e) {
                if (H && U)
                  return (
                    console.error(e),
                    i.addScene(n),
                    (this.uiScene = n),
                    this.rootEl.appendChild(n.getHtmlContainer().getElement()),
                    await this.messageBoxApi.alert(
                      t.get("TS:ModLoadError"),
                      t.get("GUI:Ok"),
                    ),
                    void U.loadMod(void 0)
                  );
                throw e;
              }
              var { mixer: b, sound: E, music: M } = await this.initSound(G, s),
                j = new Ie.AuthPopupApi(this.appLocale);
              let V = new Map()
                .set(
                  te.ScreenType.Home,
                  new Pe.HomeScreen(
                    t,
                    this.fullScreen,
                    this.appVersion,
                    !(!q.Engine.rfs || !_),
                    !q.Engine.getActiveMod() && this.config.quickMatchEnabled,
                  ),
                )
                .set(
                  te.ScreenType.Skirmish,
                  new ke.SkirmishScreen(
                    d,
                    c,
                    this.messageBoxApi,
                    t,
                    G,
                    l,
                    C,
                    F,
                    g,
                    this.localPrefs,
                  ),
                )
                .set(
                  te.ScreenType.Login,
                  new Be.LoginScreen(
                    R,
                    P,
                    I,
                    k,
                    t,
                    l,
                    this.messageBoxApi,
                    this.config.serversUrl,
                    this.config.breakingNewsUrl,
                    c,
                    this.localPrefs,
                    d,
                    this.config.devMode,
                    this.cfTurnstile,
                    this.config.legacyRegistrationEnabled,
                    this.config.authProviders,
                    j,
                    B,
                    N,
                    L,
                  ),
                )
                .set(
                  te.ScreenType.NewAccount,
                  new Ne.NewAccountScreen(
                    R,
                    t,
                    l,
                    this.messageBoxApi,
                    c,
                    this.localPrefs,
                    this.cfTurnstile,
                    this.config.legacyRegistrationEnabled,
                    this.config.authProviders,
                    j,
                    B,
                    L,
                  ),
                )
                .set(
                  te.ScreenType.QuickGame,
                  new rt.QuickGameScreen(
                    this.config.unrankedQueueEnabled,
                    this.engineVersion,
                    this.engineModHash,
                    this.appLocale,
                    G,
                    R,
                    O,
                    P,
                    d,
                    this.messageBoxApi,
                    n,
                    l,
                    t,
                    this.localPrefs,
                    E,
                    c,
                    L,
                  ),
                )
                .set(
                  te.ScreenType.Ladder,
                  new nt.LadderScreen(
                    P,
                    l,
                    c,
                    this.messageBoxApi,
                    t,
                    this.appLocale,
                  ),
                )
                .set(
                  te.ScreenType.CustomGame,
                  new De.CustomGameScreen(
                    this.engineModHash,
                    t,
                    O,
                    R,
                    P,
                    l,
                    E,
                    F,
                    c,
                    L,
                  ),
                )
                .set(
                  te.ScreenType.Lobby,
                  new Fe.LobbyScreen(
                    this.config.botsEnabled,
                    this.engineVersion,
                    this.engineModHash,
                    p,
                    d,
                    c,
                    this.messageBoxApi,
                    t,
                    n,
                    O,
                    R,
                    P,
                    k,
                    D,
                    G,
                    h,
                    u,
                    l,
                    C,
                    F,
                    g,
                    E,
                    this.localPrefs,
                  ),
                )
                .set(
                  te.ScreenType.MapSelection,
                  new _e.MapSelScreen(
                    t,
                    l,
                    C,
                    c,
                    this.messageBoxApi,
                    this.localPrefs,
                    F,
                    g,
                    f,
                    this.sentry,
                  ),
                )
                .set(
                  te.ScreenType.ReplaySelection,
                  new Ue.ReplaySelScreen(
                    this.engineVersion,
                    this.engineModHash,
                    H,
                    this.config.oldClientsBaseUrl,
                    d,
                    t,
                    l,
                    c,
                    this.messageBoxApi,
                    T,
                    n,
                    G,
                    this.sentry,
                  ),
                )
                .set(
                  te.ScreenType.Score,
                  new He.ScoreScreen(
                    t,
                    l,
                    this.messageBoxApi,
                    this.localPrefs,
                    this.config,
                    R,
                  ),
                )
                .set(
                  te.ScreenType.InfoAndCredits,
                  new Ge.InfoAndCreditsScreen(
                    t,
                    this.config,
                    this.messageBoxApi,
                  ),
                )
                .set(te.ScreenType.Credits, new Ve.CreditsScreen(t, l))
                .set(
                  te.ScreenType.Options,
                  new We.OptionsScreen(
                    t,
                    l,
                    v,
                    this.localPrefs,
                    this.fullScreen,
                    !1,
                    !!q.Engine.rfs,
                  ),
                )
                .set(
                  te.ScreenType.OptionsSound,
                  new ze.SoundOptsScreen(t, l, b, void 0, this.localPrefs),
                )
                .set(
                  te.ScreenType.OptionsKeyboard,
                  new Ke.KeyboardScreen(t, l, m),
                )
                .set(
                  te.ScreenType.OptionsStorage,
                  new qe.StorageScreen(t, l, this.messageBoxApi, q.Engine.rfs),
                );
              (B &&
                N &&
                V.set(
                  te.ScreenType.RealmSelection,
                  new je.RealmSelectionScreen(
                    t,
                    l,
                    c,
                    this.localPrefs,
                    B,
                    N,
                    L,
                    this.messageBoxApi,
                    this.config.breakingNewsUrl,
                  ),
                ).set(
                  te.ScreenType.NicknameSelection,
                  new Le.NicknameSelectionScreen(
                    t,
                    l,
                    this.messageBoxApi,
                    c,
                    d,
                    P,
                    I,
                    k,
                    R,
                    N,
                    L,
                    this.localPrefs,
                    this.cfTurnstile,
                  ),
                ),
                U &&
                  V.set(
                    te.ScreenType.ModSelection,
                    new tt.ModSelScreen(
                      d,
                      t,
                      l,
                      c,
                      this.messageBoxApi,
                      U,
                      q.Engine.getActiveMod(),
                      this.config.modSdkUrl,
                      w,
                      this.sentry,
                    ),
                  ),
                this.config.patchNotesUrl &&
                  V.set(
                    te.ScreenType.PatchNotes,
                    new $e.PatchNotesScreen(t, l, this.config.patchNotesUrl),
                  ),
                this.config.ladderRulesUrl &&
                  V.set(
                    te.ScreenType.LadderRules,
                    new ot.LadderRulesScreen(t, l, this.config.ladderRulesUrl),
                  ));
              ((O = await this.getMainMenuVideoUrl(s, _)),
                (H = new X.MainMenuRootScreen(
                  V,
                  n,
                  s,
                  t,
                  q.Engine.getImages(),
                  l,
                  O,
                  this.cdnResourceLoader,
                  E,
                  M,
                  this.sentry,
                )),
                (P = new Se.VxlGeometryCache(
                  await q.Engine.getCacheDir(),
                  q.Engine.getActiveMod(),
                )));
              let W = new be.VxlGeometryPool(P, v.graphics.models.value);
              v.graphics.models.onChange.subscribe((e) => {
                (W.setModelQuality(e),
                  W.clear(),
                  W.clearStorage().catch((e) =>
                    console.warn("Couldn't clear VXL geocache", [e]),
                  ));
              });
              ((L = new ve.BoxedVar(!1)),
                (w = new Map()),
                (_ = he.AppLogger.get("action")),
                (O = he.AppLogger.get("lockstep")),
                (P = new Te.GameLoader(
                  this.appVersion,
                  ut.workerHostApi,
                  this.cdnResourceLoader,
                  S,
                  G,
                  g,
                  E,
                  y,
                  _,
                  L,
                  s,
                  W,
                  w,
                  this.runtimeVars.debugBotIndex,
                  this.config.devMode,
                )),
                (S = new Set()));
              let z = new ve.BoxedVar(
                Boolean(
                  Number(
                    this.localPrefs.getItem(ge.StorageKey.TauntsEnabled) ?? "1",
                  ),
                ),
              );
              const K = (e) => {
                this.localPrefs.setItem(
                  ge.StorageKey.TauntsEnabled,
                  String(Number(e)),
                );
              };
              (z.onChange.subscribe(K),
                this.disposables.add(() => z.onChange.unsubscribe(K)));
              ((y = new Map()
                .set(
                  ee.ScreenType.Home,
                  new Qe.GameMenuHomeScreen(t, this.fullScreen),
                )
                .set(ee.ScreenType.Diplo, new Ye.DiploScreen(t, l, i, g, z, S))
                .set(
                  ee.ScreenType.ConnectionInfo,
                  new Ze.ConnectionInfoScreen(t, l),
                )
                .set(ee.ScreenType.QuitConfirm, new Xe.QuitConfirmScreen(t))
                .set(
                  ee.ScreenType.Options,
                  new We.OptionsScreen(
                    t,
                    l,
                    v,
                    this.localPrefs,
                    this.fullScreen,
                    !0,
                    !1,
                  ),
                )
                .set(
                  ee.ScreenType.OptionsSound,
                  new ze.SoundOptsScreen(t, l, b, M, this.localPrefs),
                )
                .set(
                  ee.ScreenType.OptionsKeyboard,
                  new Ke.KeyboardScreen(t, l, m),
                )),
                (g = new Je.LoadingScreenApiFactory(G, t, n, l, s, D)),
                (s = new lt.ClientApi()));
              (window.dispatchEvent(
                new CustomEvent("CdApiReady", { detail: s }),
              ),
                (window.CdApi = s));
              ((L = new J.GameScreen(
                ut.workerHostApi,
                D,
                I,
                R,
                k,
                this.engineVersion,
                this.engineModHash,
                c,
                y,
                g,
                h,
                u,
                this.config,
                t,
                i,
                n,
                this.runtimeVars,
                this.messageBoxApi,
                this.toastApi,
                r,
                this.viewport,
                l,
                o,
                E,
                M,
                b,
                m,
                v,
                this.localPrefs,
                _,
                O,
                T,
                this.fullScreen,
                C,
                f,
                F,
                P,
                W,
                w,
                S,
                z,
                L,
                this.sentry,
                s.battleControl,
              )),
                (s = new fe.ReplayScreen(
                  this.engineVersion,
                  this.engineModHash,
                  c,
                  y,
                  g,
                  this.config,
                  t,
                  i,
                  n,
                  this.runtimeVars,
                  this.messageBoxApi,
                  r,
                  this.viewport,
                  l,
                  o,
                  E,
                  M,
                  m,
                  v,
                  _,
                  this.fullScreen,
                  C,
                  P,
                  W,
                  w,
                  () => {
                    void 0 !== e
                      ? (window.close(),
                        (async () => {
                          (await this.destroy(),
                            document.body.appendChild(
                              document.createTextNode(
                                t.get("GUI:ReplayWindowClose"),
                              ),
                            ));
                        })())
                      : d.goToScreen(ie.ScreenType.MainMenuRoot);
                  },
                  s.battleControl,
                )));
              (d.addScreen(ie.ScreenType.MainMenuRoot, H),
                d.addScreen(ie.ScreenType.Game, L),
                d.addScreen(ie.ScreenType.Replay, s),
                i.addScene(n),
                (this.uiScene = n),
                this.rootEl.appendChild(n.getHtmlContainer().getElement()),
                await this.routeToInitialScreen(d, v, M, E, e, T));
            }
            async getMainMenuVideoUrl(e, t) {
              let i,
                r = q.Engine.rfsSettings.menuVideoFileName;
              if (e.isCdn()) i = e.getCdnBaseUrl() + r.replace(".webm", ".mp4");
              else
                try {
                  let e;
                  (t &&
                    (await t.containsEntry(r)) &&
                    (e = await t.getRawFile(r)),
                    !e &&
                      (await q.Engine.rfs?.containsEntry(r)) &&
                      (e = await q.Engine.rfs.getRawFile(r)),
                    !e &&
                      q.Engine.vfs?.fileExists(r) &&
                      (e = q.Engine.vfs.openFile(r).asFile()),
                    (i = e
                      ? new File([e], e.name, { type: "video/webm" })
                      : (console.warn(
                          "Main menu video file not found in browser FS",
                        ),
                        "")));
                } catch (e) {
                  (console.error("Failed to read video file from browser FS"),
                    (i = ""));
                }
              return i;
            }
            async routeToInitialScreen(e, t, i, r, s, n) {
              let a = !1;
              var o = this.localPrefs.getItem(ge.StorageKey.LastConnection);
              let l;
              if (o)
                try {
                  l = JSON.parse(o);
                } catch (e) {
                  console.error(`Unable to decode game params string "${o}"`);
                }
              if (l) {
                var c = await this.messageBoxApi.confirm(
                  this.strings.get("TS:ReconnectPrompt"),
                  this.strings.get("TS:Reconnect"),
                  this.strings.get("GUI:Quit"),
                );
                if (((a = !0), c))
                  return void e.goToScreen(ie.ScreenType.Game, l);
                this.localPrefs.removeItem(ge.StorageKey.LastConnection);
              }
              o = this.gpuTier;
              (void 0 !== o &&
                ((c = this.localPrefs.getItem(ge.StorageKey.LastGpuTier)),
                2 <= o.tier
                  ? void 0 !== c && Number(c) !== o.tier
                    ? ((await this.confirmHighGfxSettings()) &&
                        (t.graphics.applyHighPreset(),
                        this.localPrefs.setItem(
                          ge.StorageKey.Options,
                          t.serialize(),
                        )),
                      (a = !0))
                    : void 0 === c &&
                      o.isMobile &&
                      (t.graphics.applyLowPreset(),
                      this.localPrefs.setItem(
                        ge.StorageKey.Options,
                        t.serialize(),
                      ))
                  : (void 0 === c || 2 <= Number(c)) &&
                    ((await this.confirmLowGfxSettings()) &&
                      (t.graphics.applyLowPreset(),
                      this.localPrefs.setItem(
                        ge.StorageKey.Options,
                        t.serialize(),
                      )),
                    (a = !0)),
                this.localPrefs.setItem(
                  ge.StorageKey.LastGpuTier,
                  "" + o.tier,
                )),
                void 0 === s &&
                  this.config.patchNotesUrl &&
                  ((o = this.localPrefs.getItem(ge.StorageKey.LastSeenPatch)) &&
                    o !== this.appVersion &&
                    (await new Promise((e) =>
                      this.messageBoxApi.show(
                        p.default.createElement("iframe", {
                          src: this.config.patchNotesUrl,
                          className: "patch-notes",
                        }),
                        [
                          {
                            label: this.strings.get("GUI:Continue"),
                            onClick: e,
                          },
                        ],
                        { className: "patch-notes-box" },
                      ),
                    ),
                    (a = !0)),
                  (o && o === this.appVersion) ||
                    this.localPrefs.setItem(
                      ge.StorageKey.LastSeenPatch,
                      this.appVersion,
                    )),
                i &&
                  !a &&
                  r.audioSystem.isSuspended() &&
                  (await new Promise((e) =>
                    this.messageBoxApi.show(
                      this.strings.get("GUI:RequestAudioPermission"),
                      this.strings.get("GUI:OK"),
                      async () => {
                        (await r.audioSystem
                          .initMusicLoop()
                          .catch((e) => console.error(e)),
                          e());
                      },
                    ),
                  )));
              let h;
              if (void 0 !== s)
                try {
                  if (void 0 !== s.replayId) {
                    let e = await n.loadList();
                    var u = e.find((e) => e.id === s.replayId);
                    if (!u)
                      throw new Error(`Replay ID "${s.replayId}" not found`);
                    h = await n.loadReplay(u);
                  } else {
                    let e = new URL(s.replayUrl),
                      t = !1;
                    for (var d of this.config.replaysUrlWhitelist)
                      if (e.hostname.endsWith(d)) {
                        t = !0;
                        break;
                      }
                    if (!t)
                      throw new Error(
                        `Can't load replay from URL "${e.href}".` +
                          "Domain is not within the allowed list of domains.",
                      );
                    var g = await new le.ResourceLoader("").loadBinary(
                      s.replayUrl,
                    );
                    ((h = new T.Replay()),
                      h.unserialize(b.uint8ArrayToBinaryString(g), {
                        name: "untitled.rpl",
                        timestamp: Date.now(),
                      }),
                      h.engineVersion !== this.engineVersion &&
                        (await this.loadReplayWithOldClient(e, h.engineVersion),
                        (h = void 0)));
                  }
                } catch (e) {
                  (console.error("Failed to load replay", e),
                    await this.messageBoxApi.alert(
                      this.strings.get("GUI:ReplayError"),
                      this.strings.get("GUI:Ok"),
                    ));
                }
              h
                ? e.goToScreen(ie.ScreenType.Replay, { replay: h })
                : e.goToScreen(ie.ScreenType.MainMenuRoot);
            }
            async loadReplayWithOldClient(e, t) {
              let i;
              var r,
                s,
                n = this.config["oldClientsBaseUrl"];
              if (n) {
                this.messageBoxApi.show(this.strings.get("GUI:LoadingEx"));
                try {
                  let e = new le.ResourceLoader(n);
                  i = await e.loadJson("versions.json");
                } catch (e) {
                  console.warn("Couldn't download client version list", e);
                } finally {
                  this.messageBoxApi.destroy();
                }
              }
              let a;
              (i && (a = i[t]),
                a
                  ? ((r = (s = q.Engine.getActiveMod())
                      ? `?${S.RouteHelper.modQueryStringName}=` + s
                      : ""),
                    (s = encodeURIComponent(e.href)),
                    (window.location.href = `${n}v${a}/${r}#/replay/` + s))
                  : await this.messageBoxApi.alert(
                      this.strings.get("GUI:ReplayVersionMismatch", t),
                      this.strings.get("GUI:Ok"),
                    ));
            }
            async confirmLowGfxSettings() {
              return await this.messageBoxApi.confirm(
                p.default.createElement("div", {
                  dangerouslySetInnerHTML: {
                    __html: this.strings
                      .get("TS:RendererWarning")
                      .replace(/\n/g, "<br />")
                      .replace(
                        "{link}",
                        '<a href="https://www.windowsdigitals.com/force-chrome-firefox-game-to-use-nvidia-gpu-integrated-graphics/" target="_blank" rel="noreferrer noopener">',
                      )
                      .replace("{/link}", "</a>"),
                  },
                }),
                this.strings.get("TS:RendererUseLow"),
                this.strings.get("TS:RendererIgnore"),
              );
            }
            async confirmHighGfxSettings() {
              return await this.messageBoxApi.confirm(
                this.strings.get("TS:RendererChangeDesc"),
                this.strings.get("GUI:Yes"),
                this.strings.get("GUI:No"),
              );
            }
            initRenderer(t, e, i) {
              var { width: r, height: s } = e;
              let n = new o.Renderer(r, s);
              (n.init(t),
                this.disposables.add(n),
                c.DevToolsApi.registerVar("fps", this.runtimeVars.fps),
                this.disposables.add(() => c.DevToolsApi.unregisterVar("fps")),
                this.runtimeVars.fps.onChange.subscribe((e) => {
                  e ? n.initStats(t) : n.destroyStats();
                }),
                i && (this.runtimeVars.fps.value = !0),
                this.runtimeVars.fps.value && n.initStats(t));
              let a = new l.UiAnimationLoop(n);
              return (
                a.start(),
                this.disposables.add(a),
                t.addEventListener("contextmenu", (e) => {
                  ("A" === e.target.nodeName && e.target.href.length) ||
                    e.preventDefault();
                }),
                i ||
                  window.addEventListener("beforeunload", (e) => {
                    this.rootController?.getCurrentScreen()?.preventUnload &&
                      (e.preventDefault(), (e.returnValue = ""));
                  }),
                n.getCanvas().addEventListener("mousedown", (e) => {
                  e.preventDefault();
                }),
                { renderer: n, uiAnimationLoop: a }
              );
            }
            async initSound(e, t) {
              let i;
              var r = this.localPrefs.getItem(ge.StorageKey.Mixer);
              if (r)
                try {
                  i = new d.Mixer().unserialize(r);
                } catch (e) {
                  console.warn(
                    "Failed to read mixer values from local storage",
                    [e],
                  );
                }
              i ||
                ((i = new d.Mixer()),
                i.setVolume(m.ChannelType.Master, 0.4),
                i.setVolume(m.ChannelType.CreditTicks, 0.2),
                i.setVolume(m.ChannelType.Music, 0.3),
                i.setVolume(m.ChannelType.Ambient, 0.3));
              let s = new h.Sound(
                new u.AudioSystem(i),
                q.Engine.getSounds(),
                new g.SoundSpecs(q.Engine.getSoundIni()),
                e.audioVisual,
                document,
              );
              (s.initialize(), this.disposables.add(s));
              let n;
              try {
                n = !!(await q.Engine.rfs?.containsEntry(
                  q.Engine.rfsSettings.musicDir,
                ));
              } catch (e) {
                (console.error("Couldn't get music directory", [e]),
                  e instanceof xe.StorageQuotaError ||
                    e instanceof Ae.IOError ||
                    e instanceof ye.FileNotFoundError ||
                    this.sentry?.captureException(
                      new Error(`Couldn't get music directory (${e.name})`, {
                        cause: e,
                      }),
                    ),
                  (n = !1));
              }
              let a;
              if (n) {
                ((a = new f.Music(
                  s.audioSystem,
                  q.Engine.getThemes(),
                  new y.MusicSpecs(
                    q.Engine.getIni(q.Engine.getFileNameVariant("theme.ini")),
                  ),
                )),
                  this.disposables.add(a));
                r = this.localPrefs.getItem(ge.StorageKey.MusicOpts);
                if (r)
                  try {
                    a.unserializeOptions(r);
                  } catch (e) {
                    console.warn(
                      "Failed to read music options from local storage",
                      [e],
                    );
                  }
              }
              return { mixer: i, sound: s, music: a };
            }
            async destroy() {
              var e;
              (this.messageBoxApi &&
                (this.messageBoxApi.destroy(), (this.messageBoxApi = void 0)),
                this.rootController &&
                  (await this.rootController.leaveCurrentScreen(),
                  this.rootController.destroy()),
                this.uiScene &&
                  ((e = this.uiScene.getHtmlContainer()?.getElement()) &&
                    this.rootEl.removeChild(e),
                  this.uiScene.destroy()),
                this.disposables.dispose());
            }
          }),
        );
      },
    };
  },
);
