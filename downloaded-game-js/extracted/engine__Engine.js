System.register(
  "engine/Engine",
  [
    "data/IniFile",
    "data/ShpFile",
    "data/VxlFile",
    "data/TmpFile",
    "data/Palette",
    "engine/Theater",
    "engine/TheaterType",
    "version",
    "data/vfs/VirtualFileSystem",
    "data/vfs/RealFileSystem",
    "engine/LazyResourceCollection",
    "data/WavFile",
    "engine/LazyAsyncResourceCollection",
    "data/Mp3File",
    "engine/mixDatabase",
    "engine/gameRes/GameResSource",
    "data/Crc32",
    "game/ini/GameModes",
    "util/string",
    "engine/MapList",
    "data/HvaFile",
    "game/ini/MixinRulesType",
    "engine/EngineType",
  ],
  function (e, t) {
    "use strict";
    var c,
      h,
      i,
      r,
      s,
      n,
      a,
      o,
      l,
      u,
      d,
      g,
      p,
      m,
      f,
      y,
      T,
      v,
      b,
      S,
      w,
      C,
      E,
      x,
      O;
    t && t.id;
    return {
      setters: [
        function (e) {
          h = e;
        },
        function (e) {
          i = e;
        },
        function (e) {
          r = e;
        },
        function (e) {
          s = e;
        },
        function (e) {
          n = e;
        },
        function (e) {
          a = e;
        },
        function (e) {
          o = e;
        },
        function (e) {
          l = e;
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
          p = e;
        },
        function (e) {
          m = e;
        },
        function (e) {
          f = e;
        },
        function (e) {
          y = e;
        },
        function (e) {
          T = e;
        },
        function (e) {
          v = e;
        },
        function (e) {
          b = e;
        },
        function (e) {
          S = e;
        },
        function (e) {
          w = e;
        },
        function (e) {
          C = e;
        },
        function (e) {
          E = e;
        },
        function (e) {
          x = e;
        },
      ],
      execute: function () {
        (e(
          "Engine",
          (O = class {
            static getVersion() {
              return l.version.split(".").slice(0, 2).join(".");
            }
            static getModHash() {
              if (!this.modHash) throw new Error("Rules must be loaded first");
              return this.modHash;
            }
            static getActiveMod() {
              return this.activeMod;
            }
            static setActiveMod(e) {
              this.activeMod = e;
            }
            static initGameResSource(e) {
              this.gameResSource = e;
            }
            static async initRfs(e) {
              let t = (this.rfs = new d.RealFileSystem());
              return (t.addRootDirectoryHandle(e), t);
            }
            static async initVfs(e, t) {
              return (
                (this.vfs = new u.VirtualFileSystem(e, t)),
                c.iniFiles.setVfs(this.vfs),
                c.palettes.setVfs(this.vfs),
                c.images.setVfs(this.vfs),
                c.voxels.setVfs(this.vfs),
                c.voxelAnims.setVfs(this.vfs),
                c.tileData.setVfs(this.vfs),
                c.sounds.setVfs(this.vfs),
                c.themes.setDir(
                  await this.rfs?.findDirectory(c.rfsSettings.musicDir),
                ),
                c.taunts.setDir(
                  await this.rfs?.findDirectory(c.rfsSettings.tauntsDir),
                ),
                this.vfs
              );
            }
            static supportsTheater(t) {
              var e = this.getActiveEngine();
              return (
                this.theaterSettings.get(e)?.some((e) => e.type === t) || !1
              );
            }
            static getTheaterSettings(e, t) {
              if (!this.theaterSettings.has(e))
                throw new Error('Unknown engineType "' + e);
              var i = this.theaterSettings.get(e).find((e) => e.type === t);
              if (!i)
                throw new Error(`Unsupported theater "${o.TheaterType[t]}"`);
              return i;
            }
            static async loadTheater(e) {
              if (!c.rules || !c.art)
                throw new Error("Rules and art should be loaded first");
              if (void 0 === c.gameResSource)
                throw new Error("No gameResSource is set");
              var t = c.getActiveEngine();
              let i;
              var r,
                s = c.getTheaterSettings(t, e);
              if (c.gameResSource !== T.GameResSource.Cdn)
                for (var n of s.mixes) await c.vfs.addMixFile(n);
              return (
                c.theaters.has(e)
                  ? (i = c.theaters.get(e))
                  : ((r = c.getTheaterIni(t, e)),
                    (t = c.getTileData()),
                    (i = a.Theater.factory(e, r, s, t, c.palettes)),
                    c.theaters.set(e, i)),
                (c.activeTheater = i),
                i
              );
            }
            static unloadTheater(e) {
              if (c.vfs) {
                var t,
                  i = c.getActiveEngine();
                for (t of c.getTheaterSettings(i, e).mixes)
                  c.vfs.removeArchive(t);
              }
            }
            static unloadSideMixData() {
              for (var e of ["sidec01.mix", "sidec01cd.mix"]) {
                var t,
                  i = y.mixDatabase.get(e);
                if (!i)
                  return void console.warn(
                    `Mix "${e}" not found in mix database`,
                  );
                for (t of i)
                  ("pal" === t.split(".").pop() ? c.palettes : c.images).clear(
                    t,
                  );
              }
            }
            static getTheaterIni(e, t) {
              var i = c.getTheaterSettings(e, t).theaterIni;
              return c.getIni(i);
            }
            static loadRules() {
              var e = this.getFileNameVariant("rules.ini"),
                t = this.getFileNameVariant("art.ini"),
                i = this.getFileNameVariant("ai.ini");
              let r = this.iniFiles.get(e),
                s = this.iniFiles.get(t);
              var n = this.iniFiles.get(i);
              if (!r) throw new Error(`Rules "${e}" not found`);
              if (!s) throw new Error(`Art "${t}" not found`);
              if (!n) throw new Error(`AI "${i}" not found`);
              ((t = this.iniFiles.get(c.customRulesFileName)),
                (i = this.iniFiles.get(c.customArtFileName)));
              if (!t)
                throw new Error(`Rules "${c.customRulesFileName}" not found`);
              if (!i) throw new Error(`Art "${c.customArtFileName}" not found`);
              ((c.art = s.clone().mergeWith(i)),
                (c.rules = c.patchAudioVisualRules(r.clone().mergeWith(t))),
                (c.ai = n),
                (c.modHash = c.computeModHash()));
            }
            static patchAudioVisualRules(i) {
              if (this.activeEngine === x.EngineType.YurisRevenge) {
                let t = i.getSection("General");
                if (t) {
                  let e = i.getSection("AudioVisual");
                  var r;
                  for (r of [
                    "DamageFireTypes",
                    "OreTwinkle",
                    "BarrelExplode",
                    "BarrelDebris",
                    "BarrelParticle",
                    "NukeTakeOff",
                    "Wake",
                    "DropPod",
                    "DeadBodies",
                    "MetallicDebris",
                    "BridgeExplosions",
                    "IonBlast",
                    "IonBeam",
                    "WeatherConClouds",
                    "WeatherConBolts",
                    "WeatherConBoltExplosion",
                    "DominatorWarhead",
                    "DominatorDamage",
                    "DominatorCaptureRange",
                    "DominatorFirstAnim",
                    "DominatorSecondAnim",
                    "DominatorFireAtPercentage",
                    "ChronoPlacement",
                    "ChronoBeam",
                    "ChronoBlast",
                    "ChronoBlastDest",
                    "WarpIn",
                    "WarpOut",
                    "WarpAway",
                    "IronCurtainInvokeAnim",
                    "ForceShieldInvokeAnim",
                    "WeaponNullifyAnim",
                    "ChronoSparkle1",
                    "InfantryExplode",
                    "FlamingInfantry",
                    "InfantryHeadPop",
                    "InfantryNuked",
                    "InfantryVirus",
                    "InfantryBrute",
                    "InfantryMutate",
                    "Behind",
                    "MoveFlash",
                    "Parachute",
                    "BombParachute",
                    "DropZoneAnim",
                    "EMPulseSparkles",
                  ])
                    e?.set(r, t.getString(r));
                }
              }
              return i;
            }
            static computeModHash() {
              if (!this.vfs) throw new Error("VFS not initialized");
              let e = [
                this.customRulesFileName,
                this.customArtFileName,
                this.customMpModesFileName,
                this.shroudFileName,
                this.getFileNameVariant("rules.ini"),
                this.getFileNameVariant("art.ini"),
                this.getFileNameVariant("ai.ini"),
                ...c.mixinRulesFileNames.values(),
              ];
              var t,
                i,
                r,
                s = this.theaterSettings.get(this.getActiveEngine());
              if (!s)
                throw new Error(
                  'Unsupported engineType "' + this.getActiveEngine(),
                );
              for (t of s) e.push(t.theaterIni);
              let n = this.getMpModes();
              for (i of n.getAll()) e.push(i.rulesOverride);
              let a = new v.Crc32();
              for (r of e) {
                if (!this.vfs.fileExists(r))
                  throw new Error(`File ${r} not found`);
                var o = this.vfs.openFile(r).stream;
                a.append(new Uint8Array(o.buffer, o.byteOffset, o.byteLength));
              }
              return (
                a.append(S.binaryStringToUint8Array(this.getVersion())),
                a.get()
              );
            }
            static getRules() {
              if (!c.rules) throw new Error("Rules must be loaded first");
              return c.rules;
            }
            static getArt() {
              if (!c.art) throw new Error("Art must be loaded first");
              return c.art;
            }
            static getAi() {
              if (!c.ai) throw new Error("AI must be loaded first");
              return c.ai;
            }
            static getFileNameVariant(e) {
              var t = this.getActiveEngine();
              let i;
              if (t === x.EngineType.YurisRevenge) i = "md";
              else {
                if (t !== x.EngineType.RedAlert2)
                  throw new Error("Unsupported engine type " + x.EngineType[t]);
                i = "";
              }
              return i ? e.replace(/\.([^.]+)$/, i + ".$1") : e;
            }
            static getMpModes() {
              return new b.GameModes(
                this.getIni(this.customMpModesFileName),
                (e) => this.getIni(e),
              );
            }
            static getSoundIni() {
              var e = this.getIni("soundcd.ini");
              const t = this.getIni(this.getFileNameVariant("sound.ini"));
              return t.clone().mergeWith(e);
            }
            static getUiIni() {
              var e = this.getFileNameVariant("ui.ini");
              return this.getIni(e);
            }
            static getIni(e) {
              if (!this.iniFiles.has(e))
                throw new Error(`INI file ${e} not found.`);
              return this.iniFiles.get(e);
            }
            static async loadMapList() {
              if (!this.vfs) throw new Error("File system not initialized");
              var e,
                i,
                r,
                t = this.getMpModes();
              let s = new w.MapList(t);
              s.addFromIni(
                this.getIni(this.getFileNameVariant("missions.pkt")),
              );
              for (e of this.vfs.listArchives()) {
                var n = e.toLowerCase().replace(/\.[^.]+$/, "") + ".pkt";
                this.vfs.fileExists(n) &&
                  s.addFromIni(new h.IniFile(this.vfs.openFile(n)));
              }
              let a = new w.MapList(t),
                o = this.supportedMapTypes.get(this.getActiveEngine());
              if (!o)
                throw new Error(
                  `No map types defined for engine type "${c.getActiveEngine()}"`,
                );
              if (this.rfs)
                for await (var l of this.rfs.getEntries()) {
                  let t = l.toLowerCase();
                  try {
                    t.endsWith(".pkt")
                      ? ((i = new h.IniFile(await this.rfs.openFile(l, !0))),
                        s.addFromIni(i))
                      : o.some((e) => t.endsWith("." + e)) &&
                        ((r = await this.rfs.openFile(l, !0)),
                        a.addFromMapFile(r));
                  } catch (e) {
                    console.warn(`Couldn't read file "${l}"`, e);
                  }
                }
              return (a.sortByName(), s.mergeWith(a), (this.mapList = s), s);
            }
            static getTileData() {
              return c.tileData;
            }
            static getImages() {
              return c.images;
            }
            static getVoxels() {
              return c.voxels;
            }
            static getVoxelAnims() {
              return c.voxelAnims;
            }
            static getPalettes() {
              return c.palettes;
            }
            static getSounds() {
              return c.sounds;
            }
            static getThemes() {
              return c.themes;
            }
            static getTaunts() {
              return c.taunts;
            }
            static getActiveEngine() {
              if (!this.activeEngine)
                throw new Error("Engine type not initialized");
              return this.activeEngine;
            }
            static setActiveEngine(e) {
              this.activeEngine = e;
            }
            static getLastTheaterType() {
              return c.activeTheater?.type;
            }
            static getCacheDir() {
              try {
                return this.getOrCreateDir(this.rfsSettings.cacheDir, !0);
              } catch (e) {
                return void console.error("Couldn't get cache directory", [e]);
              }
            }
            static async getReplayDir() {
              var i = this.getActiveMod();
              if (i) {
                let e = await this.getModDir(),
                  t = await e?.getDirectory(i);
                return t?.getOrCreateDirectory(c.rfsSettings.replayDir);
              }
              return this.getOrCreateDir(this.rfsSettings.replayDir);
            }
            static getModDir() {
              return this.getOrCreateDir(c.rfsSettings.modDir);
            }
            static getMapDir() {
              return this.getOrCreateDir(c.rfsSettings.mapDir);
            }
            static async getOrCreateDir(e, t = !1) {
              let i = this.rfs?.getRootDirectory();
              if (i) return await i.getOrCreateDirectory(e, t);
            }
            static getMapList() {
              return this.mapList;
            }
            static destroy() {
              ((this.activeEngine = void 0),
                (this.activeTheater = void 0),
                (this.activeMod = void 0),
                (this.modHash = void 0),
                (this.mapList = void 0),
                (this.rfs = void 0),
                (this.vfs = void 0),
                (this.art = void 0),
                this.iniFiles.clear(),
                this.images.clear(),
                this.palettes.clear(),
                (this.rules = void 0),
                (this.ai = void 0),
                this.theaters.clear(),
                this.tileData.clear(),
                this.voxels.clear(),
                this.voxelAnims.clear());
            }
          }),
        ),
          ((c = O).UI_ANIM_SPEED = 2),
          (O.rfsSettings = {
            menuVideoFileName: "ra2ts_l.webm",
            splashImgFileName: "glsl.png",
            mapDir: "maps",
            modDir: "mods",
            musicDir: "music",
            tauntsDir: "Taunts",
            cacheDir: "cache",
            replayDir: "replays",
          }),
          (O.supportedMapTypes = new Map([
            [x.EngineType.RedAlert2, ["mpr", "map"]],
            [x.EngineType.YurisRevenge, ["mpr", "map", "yrm"]],
          ])),
          (O.images = new g.LazyResourceCollection((e) => new i.ShpFile(e))),
          (O.voxels = new g.LazyResourceCollection((e) => new r.VxlFile(e))),
          (O.voxelAnims = new g.LazyResourceCollection(
            (e) => new C.HvaFile(e),
          )),
          (O.sounds = new g.LazyResourceCollection((e) => new p.WavFile(e))),
          (O.themes = new m.LazyAsyncResourceCollection(
            (e) => new f.Mp3File(e),
            !1,
          )),
          (O.taunts = new m.LazyAsyncResourceCollection(
            async (e) => new p.WavFile(new Uint8Array(await e.arrayBuffer())),
          )),
          (O.iniFiles = new g.LazyResourceCollection((e) => new h.IniFile(e))),
          (O.tileData = new g.LazyResourceCollection((e) => new s.TmpFile(e))),
          (O.palettes = new g.LazyResourceCollection((e) => new n.Palette(e))),
          (O.theaters = new Map()),
          (O.theaterSettings = new Map()
            .set(x.EngineType.RedAlert2, [
              {
                type: o.TheaterType.Temperate,
                theaterIni: "temperat.ini",
                mixes: ["isotemp.mix", "temperat.mix", "tem.mix"],
                extension: ".tem",
                newTheaterChar: "T",
                isoPaletteName: "isotem.pal",
                unitPaletteName: "unittem.pal",
                overlayPaletteName: "temperat.pal",
                libPaletteName: "libtem.pal",
              },
              {
                type: o.TheaterType.Snow,
                theaterIni: "snow.ini",
                mixes: ["isosnow.mix", "snow.mix", "sno.mix"],
                extension: ".sno",
                newTheaterChar: "A",
                isoPaletteName: "isosno.pal",
                unitPaletteName: "unitsno.pal",
                overlayPaletteName: "snow.pal",
                libPaletteName: "libsno.pal",
              },
              {
                type: o.TheaterType.Urban,
                theaterIni: "urban.ini",
                mixes: ["isourb.mix", "urb.mix", "urban.mix"],
                extension: ".urb",
                newTheaterChar: "U",
                isoPaletteName: "isourb.pal",
                unitPaletteName: "uniturb.pal",
                overlayPaletteName: "urban.pal",
                libPaletteName: "liburb.pal",
              },
            ])
            .set(x.EngineType.YurisRevenge, [
              {
                type: o.TheaterType.Temperate,
                theaterIni: "temperatmd.ini",
                mixes: [
                  "isotemp.mix",
                  "isotemmd.mix",
                  "temperat.mix",
                  "tem.mix",
                ],
                extension: ".tem",
                newTheaterChar: "T",
                isoPaletteName: "isotem.pal",
                unitPaletteName: "unittem.pal",
                overlayPaletteName: "temperat.pal",
                libPaletteName: "libtem.pal",
              },
              {
                type: o.TheaterType.Snow,
                theaterIni: "snowmd.ini",
                mixes: [
                  "isosnomd.mix",
                  "snowmd.mix",
                  "isosnow.mix",
                  "snow.mix",
                  "sno.mix",
                ],
                extension: ".sno",
                newTheaterChar: "A",
                isoPaletteName: "isosno.pal",
                unitPaletteName: "unitsno.pal",
                overlayPaletteName: "snow.pal",
                libPaletteName: "libsno.pal",
              },
              {
                type: o.TheaterType.Urban,
                theaterIni: "urbanmd.ini",
                mixes: ["isourbmd.mix", "isourb.mix", "urb.mix", "urban.mix"],
                extension: ".urb",
                newTheaterChar: "U",
                isoPaletteName: "isourb.pal",
                unitPaletteName: "uniturb.pal",
                overlayPaletteName: "urban.pal",
                libPaletteName: "liburb.pal",
              },
              {
                type: o.TheaterType.NewUrban,
                theaterIni: "urbannmd.ini",
                mixes: ["isoubnmd.mix", "isoubn.mix", "ubn.mix", "urbann.mix"],
                extension: ".ubn",
                newTheaterChar: "N",
                isoPaletteName: "isoubn.pal",
                unitPaletteName: "unitubn.pal",
                overlayPaletteName: "urbann.pal",
                libPaletteName: "libubn.pal",
              },
              {
                type: o.TheaterType.Desert,
                theaterIni: "desertmd.ini",
                mixes: ["isodesmd.mix", "desert.mix", "des.mix", "isodes.mix"],
                extension: ".des",
                newTheaterChar: "D",
                isoPaletteName: "isodes.pal",
                unitPaletteName: "unitdes.pal",
                overlayPaletteName: "desert.pal",
                libPaletteName: "libdes.pal",
              },
              {
                type: o.TheaterType.Lunar,
                theaterIni: "lunarmd.ini",
                mixes: ["isolunmd.mix", "isolun.mix", "lun.mix", "lunar.mix"],
                extension: ".lun",
                newTheaterChar: "L",
                isoPaletteName: "isolun.pal",
                unitPaletteName: "unitlun.pal",
                overlayPaletteName: "lunar.pal",
                libPaletteName: "liblun.pal",
              },
            ])),
          (O.customRulesFileName = "rulescd.ini"),
          (O.customArtFileName = "artcd.ini"),
          (O.customMpModesFileName = "mpmodescd.ini"),
          (O.shroudFileName = "shroud.shp"),
          (O.mixinRulesFileNames = new Map().set(
            E.MixinRulesType.NoDogEngiKills,
            "nodogengikills.ini",
          )));
      },
    };
  },
);
