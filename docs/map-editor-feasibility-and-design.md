# In-Engine Map Editor: Feasibility & Design

This document assesses recreating the classic RA2 map editor — **Final Alert 2**
(FinalSun) — as a feature of this repo, but rendered through the engine's real
3D gameplay pipeline (`WorldScene`/`Renderer`/`RenderableFactory`) instead of
FinalSun's flat top-down 2D sprite view, giving mappers a true WYSIWYG editor:
correct isometric camera, real lighting (including the per-tile accumulator
described in `docs/rendering-lighting-vxl-reference.md`), shadows, VXL models,
and animations, while they edit.

It is grounded entirely in what this repo already has, not a clean-sheet
design — the honest answer turns out to be "much closer than you'd expect for
object placement, and genuinely hard for terrain and triggers."

**Ground truth source.** EA has open-sourced the real FinalSun/FinalAlert2
editor itself: `CNC_TS_and_RA2_Mission_Editor` (C++, MFC, GPL-3.0-or-later —
see its own `LICENSE.md`), a sibling checkout at
`~/development/my-experiment/CNC_TS_and_RA2_Mission_Editor/MissionEditor/`.
Large parts of this document were originally inferred from this repo's own
code and RA2 modding-community convention; several of those inferences
turned out to be wrong once checked against the real editor's source (see
§2.2's structure/aircraft field-layout correction and §5's compression
findings below) — treat any claim in this doc *not* cross-checked against
that source as still provisional. Its `MapData.cpp` (`CMapData`, ~169K, the
central map-data class) is the single most load-bearing file to check next
against any future assumption this doc makes.

## 1. What Final Alert 2 / FinalSun actually does

A working checklist of what any credible replacement needs to cover:

1. **Map bootstrap**: pick theater (Temperate/Snow/Urban), dimensions
   (`FullSize` vs `LocalSize` — the playable sub-rectangle within the full
   tile grid), starting `[Lighting]` ambient values.
2. **Terrain painting**: a tileset browser (grouped by terrain type — clear,
   cliffs of every orientation, shorelines, roads, ramps) and a brush that
   stamps `IsoMapPack5` tiles (`tileNum`/`subTile`/height `z`) onto the grid,
   including auto-transition tiles at cliff/shore boundaries.
3. **Overlay painting**: ore/gem fields, walls, fences, railroad tracks —
   `[OverlayPack]`/`[OverlayDataPack]`, a separate compressed layer from
   terrain.
4. **Object placement**: structures, vehicles, infantry, aircraft, each with
   owner/house, health %, facing, veterancy, AI flags (`AISellable`,
   `Nominal`, etc.), plus terrain decorations (`[Terrain]`) and smudges
   (craters/scorch, `[Smudge]`).
5. **Waypoints**: numbered spawn/AI points (`[Waypoints]`), critical for
   both multiplayer starting locations and trigger/AI scripting.
6. **Triggers**: a full event/action/tag scripting UI — `[Triggers]`,
   `[Events]`, `[Actions]`, `[Tags]`, cell tags, local variables — the most
   RA2-specific and complex authoring surface in the tool.
7. **Lighting tuning**: `[Lighting]` ambient/red/green/blue/ground/level
   sliders with live preview.
8. **Save/export**: serialize everything back into a working `.map` file
   without corrupting sections the tool doesn't specifically understand.

## 2. Gap analysis against this repo

### 2.1 Reading a map — solid, already done

`src/data/MapFile.ts` (`extends IniFile`) already parses essentially every
section listed above: `readTiles()` (§`IsoMapPack5`, via `Format5.decodeInto`),
`readStructures()`/`readVehicles()`/infantry/aircraft, `[Terrain]`,
`[Overlay]`/`[OverlayDataPack]`, `[Waypoints]`, `[Smudge]`, `[Lighting]`
(`MapLighting`), and a real trigger/tag/action/event reader
(`src/data/map/trigger/TriggerReader.ts`, `src/data/map/tag/TagsReader.ts`).
This is a mature, working `.map` parser — the read side is not a gap.

### 2.2 Writing a map back out — the compression half is now solved

**Generic INI round-tripping exists.** `IniFile` (`src/data/IniFile.ts`) has a
real `toString()`:

```ts
public toString(): string {
    const sectionStrings: string[] = [];
    this.sections.forEach(section => {
        sectionStrings.push(section.toString());
    });
    return sectionStrings.join("\r\n");
}
```

And `MapFile.readTiles()` only *reads* `this.getSection("IsoMapPack5")` — it
never deletes or mutates that section's raw text. So loading a map and
calling `.toString()` **without touching anything** should faithfully
reproduce sections this code doesn't specially model (`[Triggers]`,
`[Tags]`, `[CellTags]`, `[VariableNames]`, etc.) untouched, because they
just sit in the generic `sections: Map<string, IniSection>` the whole time.

**Update: this gap is closed.** At the time this document was first written,
the entire compression stack was decode-only. Both compressors now exist:

```
src/data/encoding/lzo1x.ts:     compress(state)                 // LZO1X-1, ported from minilzo-js (GPL-2.0-or-later)
src/data/encoding/MiniLzo.ts:   static compress(input)           // wraps lzo1x.compress
src/data/encoding/Format80.ts:  static encode(input)             // LCW, ported from OpenRA's LCWCompression.Encode (GPL-3.0-or-later)
```

Both were verified with `decode(encode(x)) === x` round-trips — synthetic
edge cases, real map terrain/overlay data, and a full pipeline test that
encodes, wraps the result in `Format5`'s chunk framing, splices it back into
a copy of a real `.map` file's INI text, re-parses that file from scratch,
and decodes it again, confirming an exact byte match against the original.
`Format5` itself (the chunk-framing wrapper) still only has `decode`/
`decodeInto` — an `encode`/`encodeInto` that chunks input and calls the two
compressors above per-chunk hasn't been written yet, but it's a thin,
mechanical wrapper around what already exists (see §3.4 and §5 for what's
still unverified: this has not been tested against the real game's own
engine or FinalAlert, only against this codebase's own decoder).

This means: if a mapper paints a single terrain tile, there is now a way to
turn the edited `this.tiles` array back into bytes for `[IsoMapPack5]` — the
primitive no longer blocks terrain/overlay painting. What's still missing is
everything *above* the compressor (§2.5, §3.3): `TileCollection`/
`MapTileLayer` are still immutable/build-once, so there's nowhere yet to
call the new encoder from. Object placement was never blocked by this gap in
the first place, since it's plain human-readable INI (see below).

**Update: this gap is closed too, and the field layout is now confirmed
against the real editor, not guessed.** `readStructures()`/`readVehicles()`/
`readInfantries()`/`readAircrafts()` in `src/data/MapFile.ts` now capture
every field each line format has, and `MapFile` gained mirror-image
`writeStructures()`/`writeVehicles()`/`writeInfantries()`/`writeAircrafts()`
serializers. The field positions were cross-checked against
`CMapData::AddStructure`/`AddUnit`/`AddInfantry`/`AddAircraft` in the real
editor's `MapData.cpp` (see the "Ground truth source" note above) — this
caught real bugs in an earlier pass at this fix (upgrade slots and
spotlight were at the wrong indices; a fabricated "nominal" field that
doesn't exist in the real format; Aircraft was assumed to share Vehicle's
14-field shape when it actually has its own, shorter 12-field layout with
no confirmed on-bridge slot at all). Confirmed real layouts:

- **Structure** (17 fields): `owner,name,health,rx,ry,direction,tag,
  flag1(aiSellable),flag2(aiRebuildable),energy(poweredOn),upgradeCount,
  spotlight,upgrade1,upgrade2,upgrade3,flag3,flag4`
- **Vehicle** (14 fields): `owner,name,health,rx,ry,direction,mission,tag,
  veterancy,group,onBridge,flag4,flag5,flag6` (last 3 unmodeled by this
  editor yet)
- **Infantry** (14 fields): `owner,name,health,rx,ry,subCell,mission,
  direction,tag,veterancy,group,onBridge,flag4,flag5` (last 2 unmodeled)
- **Aircraft** (12 fields): `owner,name,health,rx,ry,direction,mission,tag,
  flag1,flag2,flag3,flag4` — genuinely no confirmed onBridge slot; a
  pre-existing (not introduced by this fix) `values[length-4]` read in
  `readAircrafts()` collides with the veterancy/flag1 slot for any
  FA2-authored (i.e. virtually all) 12-field line — left unchanged rather
  than guessed at further, flagged in code comments, needs a real `.map`
  sample with an on-bridge aircraft to resolve properly.

One structural finding worth keeping in mind for any future field-position
question: this repo's `rx`/`ry` naming and the real editor's `x`/`y` naming
turned out to be **transposed relative to each other** (cross-checked via
`PosToXY`, the real editor's waypoint/cell-index decoder, against this
repo's own already-working `readWaypoints()`/`readTerrains()` math) — i.e.
the real editor's "X" is this repo's `ry` and vice versa. Once that's
accounted for, the actual byte positions agree exactly; a naive "FA2 calls
this field X, so it must be `rx`" reading would get it backwards.

Structure's `aiSellable`/`aiRebuildable`/`upgradeCount`/`spotlight`/
`upgrades`/`flag3`/`flag4` still have no live representation on the engine's
`GameObject` — `Game.ts`'s `createInitialMapTechnos()` reads them from the
loaded map once at boot and never stores them back onto the object it
creates. A structure loaded from an existing map and never touched by the
editor will lose these fields on save until that's fixed (see
`src/tools/mapEditor/GameObjectMapSerializer.ts`'s own comment on this);
Phase 1's editor doesn't expose editing any of them either way, so it's
deferred rather than fixed speculatively.

### 2.3 Scene Sandbox — the best existing scaffold, closer than expected

`src/tools/SceneSandboxTester.ts` (reachable at `/scenesandbox`, extended
this session to accept a map-title query param) is already most of an
in-game object-placement tool:

- **Real running game/world scene**, not a mock — it boots an actual `Game`
  + `WorldScene` + `Renderer`, the same ones used in real matches.
- **UI**: Type/Object/Owner/Rank/Health/Count dropdowns, speed controls,
  "Enter Placement Mode (Shift)", "Demolish Building", a super-weapon
  targeting mode.
- **Screen→tile resolution already solved**: `getTargetTileAtScreenPoint()`
  delegates to `runtime.tileHelper.getTileAtScreenPoint(pointer)` — a real
  engine helper, with a separate bridge-aware path
  (`getHighBridgeTileAtScreenPoint`) for elevated tiles. An editor doesn't
  need to invent hit-testing.
- **Click-to-place interaction**: `handlePlacementClick` listens on
  `pointer.pointerEvents` for `mouseup`, resolves the tile, and calls
  `spawnAt(tile)` using the currently-selected dropdown values. Shift held
  down keeps placement mode active for rapid multi-placement.

What it does **not** have, that an editor needs:
- No placement **preview/ghost** — objects appear only on click, there's no
  cursor-following preview mesh showing facing/footprint before commit
  (grepped for "ghost"/"preview" in the file — absent).
- No **selection/gizmo** system for picking up and moving/rotating an
  already-placed object (it only supports demolish, not move or re-edit
  fields on an existing instance).
- No concept of "this is *the* map being authored" vs. "this is a scratch
  sandbox" — nothing here persists to a `.map` file; `spawnAt` creates live
  `GameObject`s through the normal game-object factory, not `MapFile`
  section entries.

### 2.4 MapSnapshotRenderer — the loading bootstrap template, not the editor host

`src/gui/screen/mainMenu/mapSel/MapSnapshotRenderer.ts` (built earlier this
session) shows exactly how to stand up a full `Game`/`WorldView`/`WorldScene`
from an arbitrary loaded `MapFile` with no live multiplayer match — its
`createGame()`/`removeStartingUnits()` pattern (two dummy players, one
`game.start()` call, then strip the default starting units/base) is the
right template for an editor's "open this map file into a real scene"
bootstrap. The key difference: it's a one-shot render-and-dispose (build
scene → render once → tear down), whereas an editor needs that same
bootstrap to produce a **persistent, interactive** scene that stays mounted
while the mapper works — closer in shape to how `SceneSandboxTester`
keeps its scene alive across an editing session.

### 2.5 Terrain mutability — the deepest architectural gap

`src/game/map/TileCollection.ts` is built as an **immutable snapshot**:
`tilesByRxy`/`tilesByDxy`/`tiles` are private arrays populated once in the
constructor from the `TileData[]` passed in, with no `setTile`/`updateTile`
method anywhere in the class. Every existing consumer (`getByMapCoords`,
`getInRectangle`, `getAllNeighbourTiles`, ...) is read-only.

`src/engine/renderable/entity/map/MapTileLayer.ts` renders terrain as **one
merged mesh**, built once:

```ts
const mergedGeometry = BufferGeometryUtils.mergeBufferGeometries(geometries);
```

Its only incremental-update path, `updateLighting(tiles?)`, patches just the
`vertexColorMult` buffer attribute (the lighting tint from
`Lighting.compute()`) — it has no concept of "this tile's `tileNum` changed,
regenerate its quad." Repainting a tile's actual terrain art today would
require rebuilding the *entire* merged geometry (potentially tens of
thousands of tiles), since there is no per-tile geometry handle kept around
after merging.

This is the compounding reason terrain painting is the hard part: it's not
just the missing LZO encoder (§2.2) — it's that both the in-memory tile grid
and its render representation are architected as build-once snapshots, not
mutable structures with an update path.

**The real editor confirms this is the right shape to build, though.**
`CMapData` in the real editor's `MapData.cpp` keeps terrain/overlay state as
a flat, directly-mutable array (`FIELDDATA fielddata[x + y*IsoSize]`,
`MapData.h`) with **a per-tile dirty bit** (`bRedrawTerrain : 1`) that its
renderer (`IsoView.cpp`) checks each frame to redraw only changed tiles —
structurally the same "mutable grid + per-tile invalidation" shape
`Lighting.tileLights`/`MapTileLayer.updateLighting()` already use for
lighting in this repo, just not yet extended to tile art. Worth copying
that dirty-flag pattern directly: a `TileCollection` mutation method should
mark affected tiles, and `MapTileLayer`'s incremental-update path (§3.3)
should consume that same dirty list rather than needing its own tracking.

### 2.6 Save/publish backend — already exists, no new infrastructure needed

`server/src/http/mapRoutes.ts` already has `POST /maps/upload` (raw body,
SHA-256 dedup, INI-integrity validated — see `docs/map-server-design-and-
plan.md` §4.2) and `MapStore` already indexes/serves maps by content hash.
An editor's "Save"/"Publish" button can `PUT`/`POST` the serialized `.map`
text to this existing endpoint; no new server-side plumbing is needed for
storage or distribution, only client-side serialization (§2.2) needs to
exist first.

### 2.7 Nothing pre-existing to build on beyond the above

Grepped `src/` for `editor`, `MapEditor`, `TerrainBrush`, `PlacementTool` —
no hits beyond an unrelated string in `LanSetup.tsx`. There is no partial
editor effort already in the codebase; everything above is inference from
adjacent tools, not discovery of hidden editor code.

## 3. Architecture proposal

### 3.1 Scene host: extend the Scene-Sandbox model, don't replace it

Build the editor as a new screen that follows `SceneSandboxTester`'s shape
almost exactly — bootstrap via the `MapSnapshotRenderer.createGame()`
pattern but keep the resulting `Game`/`WorldScene`/`Renderer` alive for the
whole editing session, add an `EditorController` layer on top that:

- Owns "edit mode" state (Terrain / Overlay / Objects / Waypoints /
  Triggers / Lighting), analogous to Scene Sandbox's Type/Object dropdowns
  but scoped per mode.
- Reuses `tileHelper.getTileAtScreenPoint` for all hit-testing (§2.3) — no
  new raycasting/picking code needed.
- Adds a **placement-preview object**: a semi-transparent clone of the
  selected object's renderable, position-synced to the hovered tile each
  frame, only committed to the real `MapFile` model on click. (Scene
  Sandbox's direct-spawn-on-click is fine for a game-testing tool; an editor
  needs the preview.)
- Adds a **selection/gizmo** layer: click an existing object to select it
  (reuse the existing unit-selection/outline rendering already used for
  normal gameplay unit selection), drag to reposition, a small property
  panel for owner/health/facing/veterancy.

### 3.2 The critical new layer: an editable map *model*, separate from the live game

This is the piece nothing today provides. `MapFile`'s parsed arrays
(`this.tiles`, `this.structures`, ...) need to become the **source of
truth** the editor mutates directly, with the live `WorldScene` treated as a
*view* over that model that gets incrementally re-synced, rather than (as
Scene Sandbox does) spawning live `GameObject`s that have no connection back
to `MapFile` sections at all. Concretely:

- Object placement/move/delete → mutate `MapFile.structures`/`vehicles`/...
  directly, then create/update/remove the corresponding renderable via
  `RenderableFactory` (already how the live game syncs game objects to
  renderables — `RenderableManager.createRenderable()`).
- Terrain painting → mutate `MapFile.tiles[i]`, then patch just the affected
  tile's geometry/texture-atlas region in `MapTileLayer` (new capability,
  §3.3) rather than trigger a full rebuild per brush stroke.

### 3.3 New capability: incremental terrain mesh updates

`MapTileLayer` needs a real "repaint this tile" path. Confirmed directly by
reading `MapTileLayer.ts` and `SpriteUtils.ts` (not just inferred) — two
viable tiers, roughly in order of engineering cost:

1. **Tier 1 — cheap, texture-only, art already resident in the atlas.**
   Since terrain tiles are drawn from a shared `TextureAtlas`, if the new
   tile's art is already packed, only the affected sprite's UV rect in the
   merged geometry's `uv` buffer attribute needs updating in place — same
   technique `updateColorMultBufferAtIndex` already uses for the color-mult
   buffer, keyed by the already-tracked `tileIndexes.get(tile)`.

   **One subtlety the original version of this document missed, worth
   flagging explicitly**: each tile is not one quad. `SpriteUtils.
   createSpriteGeometry` (the function `MapTileLayer.createTileObjects`
   calls to build each tile's geometry) always splits a sprite into **two**
   indexed rects — left half and right half, `splitX = spriteWidth / cosY /
   2` when `depth` isn't requested (which `MapTileLayer`'s call doesn't) —
   merged together, 8 vertices total (`VERTICES_PER_SPRITE` with
   `USE_INDEXED_GEOMETRY = true`). A correct per-tile UV patch has to call
   `SpriteUtils.writeIndexedRectUvsIntoBuffer` **twice**, once per half with
   its own partial `textureArea` slice — exactly mirroring
   `createSpriteGeometry`'s own `addRectUvs(leftGeometry, {...textureArea,
   width: splitX}, imageSize)` / `addRectUvs(rightGeometry, {...textureArea,
   x: textureArea.x + splitX, width: textureArea.width - splitX},
   imageSize)` calls. Writing only one rect (the realistic first-attempt
   mistake) would leave half of every repainted tile showing stale/garbage
   UVs, not fail loudly.

   This also means `MapTileLayer` needs two new persistent fields it
   currently discards after use: the merged geometry's `uv`
   `BufferAttribute` itself (currently a local `const uvAttribute` used only
   for a one-time sanity check, never stored on `this` the way
   `colorMultAttribute` is), and a `Map<Tile, IndexedBitmap>` recording
   which atlas-packed drawable each tile currently shows (`tileImageMap` is
   already built during `createTileObjects` but is local, not kept).

2. **Tier 2 — general case: art not yet in the atlas, or a height/`z`
   change.** Confirmed by reading `TextureAtlas.pack()` directly: it always
   allocates a fresh `GrowingPacker` and a brand-new `THREE.DataTexture`,
   with no incremental-add API. Re-packing to fit a genuinely new drawable
   reflows **every** block's position, not just the new one — so this tier
   isn't "rebuild one tile," it's "recompute and rewrite the UV pair for
   every tile in the map, then swap `material.map` to the new texture and
   set `material.needsUpdate = true`." Still well short of rebuilding the
   merged *geometry* (positions/indices are untouched, only UVs and the
   texture), but a genuinely full-map operation, confirmed rather than
   assumed. A height/`z` change is a separate, harder case again — it moves
   the sprite's world position (`Coords.tile3dToWorld`), which lives in the
   `position` attribute this tier doesn't touch at all; out of scope for the
   first version of terrain painting (see §4's Phase 2 step list).

   Practically: most real brush strokes repaint using art already present in
   the loaded map's own theater tileset (adjacent terrain variants, cliff/
   shore auto-transition tiles the mapper is already using elsewhere), so
   Tier 1 should cover the large majority of editing; Tier 2 exists for
   completeness and for genuinely introducing new tileset variants.

3. **Wiring gap, not yet closed**: `MapTileLayer` (owned by `MapRenderable.
   tileLayer`) isn't reachable from outside `WorldView` today —
   `WorldView.init()`'s return value is `{ worldScene, worldSound,
   renderableManager, superWeaponFxHandler, beaconFxHandler }`, no
   `mapRenderable`. `MapEditorTester` (or any future paint-mode UI) has no
   handle to call a future `repaintTile()` on without this. Small, additive,
   low-risk fix: add `mapRenderable` to that returned object literal —
   see §4's Phase 2 step list, step 0.

### 3.4 New capability: `.map` serialization

- **Object sections**: done (§2.2) — `MapFile.write{Structures,Vehicles,
  Infantries,Aircrafts}()` now serialize every captured field per object
  type, confirmed against the real editor's field layouts.
- **Terrain**: the Format80/LZO1X encoders now exist (`Format80.encode`,
  `MiniLzo.compress` — see §2.2) and have passed round-trip fidelity testing
  against real map data. The `Format5` chunk-framing wrapper (`encode`/
  `encodeInto`, still missing) no longer needs any guessing either — the
  real editor's chunk format is confirmed byte-for-byte via
  `3rdParty/xcc/misc/shp_decode.cpp`'s `encode5`/`t_pack_section_header`:
  a `{ uint16 size_in; uint16 size_out; }` header per chunk, fixed
  **8192-byte** chunk size, calling `encode5s` (LZO, via the genuine
  `lzo1x_1_compress`) or `encode80` (LCW) per chunk depending on format —
  exactly what this repo's `Format5.decodeInto` already assumes, so this is
  now purely mechanical to implement.

  **One real discrepancy worth resolving before trusting a terrain
  encoder, though**: the real editor's actual terrain-save call is
  `FSunPackLib::EncodeIsoMapPack5(...)` (`MapData.cpp:1241`), a distinct
  function — not a direct call into the generic LZO/`encode5` path used for
  `[OverlayPack]`/`[OverlayDataPack]` (both of which the real editor packs
  via `EncodeF80`/LCW, confirmed at `MapData.cpp:1163,1203` — *not* LZO for
  `OverlayPack` as this repo's own naming/`Format5`-format-number
  convention might suggest). Since this repo's own `IsoMapPack5` *decoder*
  already works correctly today (real terrain renders correctly in actual
  gameplay), `EncodeIsoMapPack5` is most plausibly a wrapper that also
  handles packing the `FIELDDATA` struct fields into `IsoMapPack5`'s
  specific per-tile byte layout before calling the same generic LZO
  compressor beneath it — not a genuinely different compression codec —
  but this is inference, not a confirmed reading of that function's body.
  Read `FSunPackLib::EncodeIsoMapPack5`'s actual implementation (likely in
  `MissionEditorPackLib/`) before relying on `MiniLzo.compress()` directly
  for real terrain writes; also note `MapData.cpp:1096-1097`'s own comment
  — `// only activate when packing isomappack is supported` — suggesting
  even this "modernized" 2024 release treats terrain packing as
  not-fully-proven.
  What's still needed beyond the encoder question for this phase: the
  actual mutable-terrain-model work in §2.5/§3.3, which no encoder touches.
- **Everything else** (triggers, tags, lighting, waypoints, basic/map
  metadata): already round-trips via `IniFile.toString()` as long as the
  editor doesn't touch those sections' underlying `IniSection` data — so
  Phase 1/2 (§4) can ship *before* a trigger-editing UI exists, as long as
  the editor is careful to leave `[Triggers]`/`[Tags]`/etc. completely alone
  when saving.

### 3.5 Editor-specific UI chrome

A new toolbar (mode switch, brush/tileset browser, layer visibility toggles)
and property panels are pure new UI work with no particular technical risk,
built the same way `SceneSandboxTester`'s existing dropdown/button panel is
built.

## 4. Phased implementation plan

### Status checklist

**Phase 1 — Object placement editor: shipped.**

- [x] Step 1: fix/extend the map-object parser (`MapObjects.ts`, `MapFile.ts`
      `read*`) — full field capture, real editor-confirmed layouts
- [x] Step 2: reverse serializers — `MapFile.write{Structures,Vehicles,
      Infantries,Aircrafts}()`
- [x] Step 3: `GameObject → MapObjects` extraction —
      `GameObjectMapSerializer.ts`'s `extractMapObjects()`
- [x] Step 4: full save pipeline proven end-to-end (no UI) —
      `MapEditorSaveEndToEnd.test.ts`
- [x] Step 5: shared placement primitives extracted — `TileTargeting.ts`,
      `ObjectCatalog.ts` (narrower than originally sketched; see §4 Phase 1
      write-up for why)
- [x] Step 6: `MapEditorTester` built and reachable at `/mapeditor`
- [x] Step 7: `/mapeditor` route registered
- [x] Bonus (found necessary during live testing, not in the original 7):
      Delete Object Mode, Download Map File, editable Save-As filename,
      localhost-only dev session token
- [x] Bonus fix: `WorldInteraction` no longer eats Backspace/arrow keys
      typed into real HTML inputs (`WorldInteraction.ts`)
- [ ] Placement-preview/ghost object before commit (§3.1) — not built,
      click-to-commit only
- [ ] Selection/gizmo to move or re-edit an already-placed object (§3.1) —
      not built, add/delete only
- [ ] Round-trip fidelity verified against a **real official map** (load →
      `toString()` with zero edits → diff against original bytes) — only
      verified against synthetic test fixtures so far (§5, still open)

**Phase 2 — Terrain & overlay painting: planned, not started.**

- [ ] Step 1: `Format5.encode`/`encodeInto`
- [ ] Step 2: expose `mapRenderable` from `WorldView.init()`
- [ ] Step 3: `TileCollection.repaintTile()`
- [ ] Step 4: `MapTileLayer` persistent `uv`/drawable state +
      `repaintTile()` (Tier 1: art already in atlas)
- [ ] Step 5: `MapFile.writeTiles()` (`[IsoMapPack5]`) — blocked on
      resolving the `EncodeIsoMapPack5` open question (§3.4, §5) before
      trusting it for real saves
- [ ] Step 6: `MapFile.writeOverlays()` (`[OverlayPack]`/`[OverlayDataPack]`)
- [ ] Step 7: paint-mode UI in `MapEditorTester` (tile-art picker + mode
      toggle)
- [ ] Step 8: wire `buildMapIniString()` to call the new writers
- [ ] Tier 2 (new art not yet in atlas, full repack) — deliberately deferred
      past v1 (§4 design decision 2)
- [ ] Height/`z` painting — deliberately excluded from v1 (§4 design
      decision 1)

**Phase 3 — Trigger/tag/AI scripting UI: sketched only, not planned to
step level.**

- [ ] Dedicated research/planning pass (this phase's own detailed plan,
      mirroring Phase 1/2's) — not started
- [ ] `TeamTypes`/`TaskForces`/`ScriptTypes` parser — confirmed zero
      references in `MapFile.ts` today, a complete gap, not just lossy
      handling
- [ ] Trigger/Event/Action/Tag editing UI, using `FAData.ini`'s
      `[EventsRA2]`/`[ActionsRA2]` as the parameter-type registry (§4)

**Phase 4 — Lighting tuning, map bootstrap, polish: sketched only.**

- [ ] New-map bootstrap from `StdMapRA2.ini`'s confirmed template content
- [ ] Resize / theater switch
- [ ] Live `[Lighting]` tuning UI (`MapLighting`/`Lighting.compute()` already
      support this "essentially for free" once an editable model exists)
- [ ] Undo system — **no design exists yet for either phase**: terrain/
      overlay should borrow the real editor's bounding-box snapshot
      approach (Phase 2), object placement needs a separate add/remove/move
      operation stack (Phase 1) — see §4's "no undo design exists" note

**Cross-phase, not tied to one phase specifically:**

- [ ] LZO/Format80 encoder output validated against the real game or CNCMaps
      Renderer (not just this repo's own decoder) — still open (§5)
- [ ] Structure fields with no live `GameObject` representation
      (`aiSellable`/`aiRebuildable`/`upgradeCount`/`spotlight`/`upgrades`/
      `flag3`/`flag4`) — still lost on save for untouched structures (§5)
- [ ] Tunnel/tube editing, dedicated map validation, bitmap-to-map import —
      noted for completeness, no phase assigned (§4)

**Phase 1 — Object placement editor. Shipped.** All 7 steps of the
implementation plan (`.claude/plans/eventual-prancing-willow.md`) are done,
committed, and verified end-to-end live in a real browser — not just unit
tests. What exists today, reachable at `/mapeditor`:

- `src/tools/MapEditorTester.ts` — a persistent editor scene (real
  `Game`/`WorldView`/`WorldScene`/`Renderer`, real lighting/shadows/VXL),
  structured after `MapSnapshotRenderer.createGame()`'s bootstrap pattern.
  One combatant `Player` is built per house the loaded map's technos
  reference (plus every standard multiplayer house), so `Game.init()` can be
  called with the new `includeNonNeutralMapTechnos` option (`Game.ts`) and
  load *every* pre-placed object, not just neutral-owned ones — closing the
  Phase 1 open risk this document originally flagged. Gameplay systems are
  suppressed by simply never starting a game-tick interval (only
  `UiAnimationLoop`'s render loop runs), since AI/triggers/combat/
  superweapons are all driven from `game.update()` — the cleanest possible
  version of §5's "scope of real in-game rendering" suppression concern.
- **Place**, **Delete**, **Download Map File** (client-side, no auth), and
  **Save to Server** (`POST /maps/upload`, auth via a pasted WOL session
  bearer token) are all live and manually verified: placed/deleted objects
  render immediately with correct lighting, and both the downloaded file and
  the server-stored blob contain byte-correct `[Structures]`/`[Units]`/
  `[Infantry]`/`[Aircraft]` lines with the rest of the map preserved
  untouched. Delete and Download were added after the original 7-step plan,
  in response to live testing — not in the original scope, but small,
  contained additions (`deleteObjectAt()`/`downloadMap()` in the same file).
- `src/tools/shared/TileTargeting.ts` and `src/tools/shared/ObjectCatalog.ts`
  — extracted from `SceneSandboxTester` (screen→tile resolution including
  high-bridge picking; object catalog + display-name resolution). Narrower
  than this plan's original §3.1 sketch, which imagined a single shared
  "placement primitives" extraction covering spawn logic too — reading the
  actual code showed `spawnAt`/`setPlacementActive` are tightly coupled to
  Scene-Sandbox-only concepts (synthetic local/enemy owner toggle, count-
  based multi-spawn, veterancy/health presets, superweapon auto-arm) that an
  editor shouldn't inherit, so `MapEditorTester` writes its own leaner
  placement/delete logic on top of just the tile-targeting and catalog
  primitives.
- The `GameObject`↔`MapFile` sync layer (§3.2) exists as
  `src/tools/mapEditor/GameObjectMapSerializer.ts`'s `extractMapObjects()`,
  feeding `MapFile.write{Structures,Vehicles,Infantries,Aircrafts}()`. This
  turned out sufficient without the fuller "editable model separate from the
  live game" architecture §3.2 originally proposed — Phase 1 routes
  everything through live `GameObject`s (extraction runs at save time, not
  continuously), which was enough for object placement specifically. Phase 2
  needs the fuller model (§3.2, §2.5) since a live tile mesh can't be "the
  model" the way a `GameObject` already is.
- **Not built**: the placement-preview/ghost object and selection/gizmo
  system §3.1 originally sketched. Placement is still click-to-commit
  (matching Scene Sandbox's UX, not FinalSun's preview-then-place UX) and
  there's no way to select-and-move an already-placed object, only add/
  delete. Worth its own follow-up if move/preview UX becomes a priority, but
  wasn't necessary to hit "real WYSIWYG object placement that saves
  correctly," which was the actual bar for calling Phase 1 done.

**Phase 2 — Terrain & overlay painting.** Next up. The compression encoders
(§3.4) are done and validated in isolation; what's left is the `Format5`
chunk-framing wrapper, incremental `MapTileLayer` updates (§3.3), and making
`TileCollection` mutable (§2.5). Planned below at the same file/method-level
detail Phase 1's implementation plan used
(`.claude/plans/eventual-prancing-willow.md`), informed by direct reading of
`TileCollection.ts`, `MapTileLayer.ts`, `SpriteUtils.ts`, `TextureAtlas.ts`,
and `WorldView.ts` this pass — not re-guessed from the original sketch
above. Overlay painting (ore/walls) follows the same shape once terrain
works (design decision 4, step 6 below).

*Design decisions:*

1. **`TileCollection` mutation is texture-only in v1, no height/`z`
   changes.** Add `repaintTile(rx, ry, tileNum, subTile, tileSets,
   randomIndexSelector): Tile` that looks up the existing `Tile` object via
   the internal `tilesByRxy`/`tilesByDxy` arrays and mutates its `tileNum`/
   `subTile`/`terrainType`/`landType`/`rampType` fields **in place** — since
   `Tile` is a plain object with no `readonly` enforcement and the same
   object reference is stored in both lookup arrays, an in-place mutation
   needs no additional bookkeeping to stay consistent. `rx`/`ry`/`dx`/`dy`/
   `z`/`id` are left untouched. Height changes are excluded because they
   ripple into far more than rendering — `computeAllPassabilityGraphs()`,
   `Coords.tile3dToWorld`'s world position (§3.3 Tier 2), min/max/cutoff
   tile height, cliff-adjacency (`computeLandBehindCliffTiles`, run once at
   construction) — each a separate, harder problem not worth conflating with
   "repaint this tile's art." **Known v1 limitation, not fixed**: repainting
   a tile into or out of a `TerrainType.Cliff` won't re-trigger
   `computeLandBehindCliffTiles`'s one-time neighbor-`landType` side effect,
   so cliff-adjacent passability can go stale after such an edit — acceptable
   for a first version that's mainly about flat-terrain art painting
   (clear/shore/road variants), not cliff reshaping.
2. **`MapTileLayer.repaintTile()` is Tier 1 only in v1** (§3.3) — texture
   swap for art already resident in the atlas. Tier 2 (new art, full atlas
   repack) is real, scoped, and described in §3.3, but adds meaningfully
   more risk (every tile's UVs rewritten, texture swap) for less common
   real-world usage (§3.3's "most brush strokes reuse existing theater
   art" reasoning) — ship Tier 1, come back for Tier 2 once Tier 1 is
   proven solid in real use, rather than building both at once.
3. **`Format5.encode` first, before any mutability work.** Zero dependency
   on the mutability work below — it's a pure function operating on bytes
   the existing round-trip tests already exercise via `decode`. Doing it
   first means every later step (writeTiles/writeOverlays) has a working,
   already-tested encoder to call, rather than discovering an encoder bug
   at the same time as a new mutability bug.
4. **`MapFile.writeTiles()`/`writeOverlays()` mirror the Phase 1 write*
   pattern exactly** — pure data-in/INI-out, no `Game`/live-object
   dependency, matching how `writeStructures()` etc. stay dependency-free.
   Unlike Phase 1's writers, these read from a mutated `TileCollection`/
   overlay array rather than from `extractMapObjects()`'s live-`GameObject`
   inversion, since terrain/overlay have no `GameObject` representation at
   all — `TileCollection` itself is the editable model here (§3.2's
   "terrain painting → mutate `MapFile.tiles[i]`" sketch, now made concrete:
   it's actually `MapFile`'s own `TileCollection` instance, not a separate
   `tiles[]` array).

*Ordered implementation steps* (each independently testable, matching
Phase 1's step discipline):

1. **`Format5.encode`/`encodeInto`** (`src/data/encoding/Format5.ts`): chunk
   input into 8192-byte pieces (confirmed spec, §3.4), write the `{u16
   size_in (compressed); u16 size_out (decompressed)}` header per chunk,
   call `MiniLzo.compress`/`Format80.encode` depending on the `format`
   param, mirroring `decodeInto`'s existing chunk-loop shape in reverse.
   *Test*: round-trip a real `[IsoMapPack5]`/`[OverlayDataPack]` blob
   extracted from an actual map file through `decode(encode(x))`, byte-
   compare. No engine/UI dependency — pure data, like Phase 1 steps 1-2.
2. **Expose `mapRenderable` from `WorldView.init()`** (§3.3 point 3):
   add it to the returned object literal (`src/gui/screen/game/
   WorldView.ts`'s `return { worldScene, worldSound, renderableManager,
   superWeaponFxHandler, beaconFxHandler, mapRenderable }`). Purely
   additive — existing destructuring call sites (`SceneSandboxTester`,
   `MapSnapshotRenderer`, `MapEditorTester`) that don't ask for the new
   field are unaffected. *Test*: `tsc --noEmit`, then a manual smoke check
   that `/scenesandbox` and `/mapeditor` still boot and behave identically.
3. **`TileCollection.repaintTile()`** (design decision 1 above).
   *Test*: standalone script (matching Phase 1's scratchpad-script
   pattern) — construct a `TileCollection` from fixture `TileData[]`,
   call `repaintTile`, assert `getByMapCoords(rx, ry)` returns the mutated
   `tileNum`/`subTile`/`terrainType` and that `getByDisplayCoords` for the
   same tile's `dx`/`dy` returns the *same object* (reference equality),
   proving the in-place mutation stayed consistent across both lookup
   paths. No engine/UI dependency.
4. **`MapTileLayer` persistent state + `repaintTile()` (Tier 1)**
   (§3.3 points 1 and design decision 2): store `uvAttribute` and a
   `tileDrawableMap: Map<Tile, IndexedBitmap>` as fields at build time
   (mechanical addition inside the existing `createTileObjects` loop);
   add `repaintTile(tile: Tile, newDrawable: IndexedBitmap): boolean`
   that looks up `tileIndexes.get(tile)` for the vertex offset, computes
   the offset's two half-rect `textureArea`s via `textureAtlas.
   getImageRect(newDrawable)` mirroring `createSpriteGeometry`'s own
   split math, calls `SpriteUtils.writeIndexedRectUvsIntoBuffer` twice
   into `uvAttribute.array`, sets `uvAttribute.needsUpdate = true`, and
   updates `tileDrawableMap.set(tile, newDrawable)`. Returns `false`
   (caller falls back to Tier 2, not built yet in this step) if
   `newDrawable` isn't in the atlas. *Test*: needs a real WebGL context —
   verify visually (via `/mapeditor` once step 8 wires a paint UI, or a
   minimal standalone repaint-test route if that's not ready yet) that
   repainting one tile changes only that tile's rendered art with no
   seam/UV corruption on the shared edge between its two half-rects, and
   that `updateLighting()` (unmodified, shares the same `tileIndexes` map)
   still tints the repainted tile correctly afterward.
5. **`MapFile.writeTiles()`**: mirrors `writeStructures()`'s pattern —
   iterate `this.tiles.getAll()`, re-encode via `Format5.encode` into
   `[IsoMapPack5]`. **Before trusting this for real saves**, resolve §3.4's
   open `EncodeIsoMapPack5`-may-not-be-the-generic-path question (read
   `FSunPackLib::EncodeIsoMapPack5`'s actual implementation) — this step
   can still be built and tested against this repo's own decoder in the
   meantime, same caveat Phase 1 already lived with for structure fields
   before the FA2-source check happened. *Test*: fixture round-trip (read →
   `repaintTile` one tile → `writeTiles()` → re-read → assert the one
   mutation stuck and every other tile matches the original), matching
   Phase 1 step 2's round-trip test shape.
6. **`MapFile.writeOverlays()`**: same pattern, `[OverlayPack]`/
   `[OverlayDataPack]` via `Format80.encode` — not subject to the
   `EncodeIsoMapPack5` open question (§3.4 already confirms overlay uses
   the generic LCW path, `EncodeF80`, at the real editor's
   `MapData.cpp:1163,1203`), so no blocker analogous to step 5's.
7. **Paint-mode UI in `MapEditorTester`**: a tile-art picker (grouped by
   terrain type, reusing whatever tileset browsing this repo's theater
   loading already exposes) + a "Paint Terrain Mode" toggle button,
   following the exact mutual-exclusivity pattern `placementActive`/
   `deleteActive` already established in Phase 1 (`setPlacementActive`/
   `setDeleteActive` both reset each other) — add `paintActive` as a third
   mutually-exclusive mode. Click handler calls `TileCollection.
   repaintTile()` then `MapTileLayer.repaintTile()` (falling back to a
   "not in atlas yet" status message, not Tier 2, in this step) at the
   clicked tile. Single-tile only in this step; multi-tile brush radius
   is a follow-up, not required to prove the mechanism end-to-end.
8. **Wire `buildMapIniString()` to also call the new writers**: currently
   (`src/tools/MapEditorTester.ts`) it only calls the four object writers;
   add `writeTiles()`/`writeOverlays()` calls so Download/Save-to-Server
   actually persist terrain edits, not just object placement.

*Verification (Phase 2, end-to-end)*, mirroring Phase 1's:

1. `bunx tsc --noEmit` clean after each step.
2. Steps 1, 3, 5, 6: standalone script/test assertions, no browser needed
   (same shape as Phase 1 steps 1-4).
3. Steps 4, 7: manual browser check at `/mapeditor` — repaint a tile,
   confirm correct rendering, confirm Download/Save still produce a
   correct file (§5's still-open "round-trip fidelity against a real
   official map" risk should be closed around here too, not deferred
   further — this is the first phase where an editor can actually corrupt
   terrain data, unlike Phase 1's purely additive object placement).
4. Before shipping terrain edits to real players (not just this repo's own
   decoder): validate encoded output against the actual game or CNCMaps
   Renderer, per §5's existing LZO/Format80 risk bullet — still unclosed,
   inherited unchanged from before this phase started.

**Phase 3 — Trigger/tag/AI scripting UI.** The largest, most RA2-specific
surface (event/action pairing, tag linking, cell tags, variables, base/AI
triggers) and the one most likely to desync from the actual game logic's
interpretation of these structures if the UI's model of "what a trigger
means" drifts from `TriggerReader`'s. Start from `TriggerReader`/`TagsReader`
/`CellTagsReader`'s parsed model as the UI's data model directly (don't
reinvent a parallel trigger representation), and keep raw round-trip
fidelity as the fallback for anything the UI doesn't yet expose editing for.

The real editor doesn't parse `[Events]`/`[Actions]` into typed structs
either — it edits them as raw comma-separated `IniSection` strings, keyed by
trigger ID, with a **shipped, complete parameter-type registry**:
`MissionEditor/data/FinalAlert2/FAData.ini`'s `[EventsRA2]`/`[ActionsRA2]`
sections (GPL-3.0-or-later, same license as the rest of that repo) map every
RA2 event/action type ID to its display name, a description, and
parameter-shape codes (e.g. `2`=house, `6`=number, `7`=team-type reference,
`8`=building-type, `13`=text-label string, `14`=trigger reference,
`16`=sound effect, `30`=waypoint; negative codes flag a "reference by name
into another section" case). This is directly usable as the parameter
registry for a real Phase 3 UI — pulling `FAData.ini` in as a reference
asset avoids reverse-engineering RA2 trigger semantics from scratch, by far
the most valuable single find for this phase. Confirmed field shapes:
`[Events]` lines are `count,type1,p1a,p1b[,extra1],type2,...` (variable
length — an event gets a 4th parameter field only when its own 2nd field
is `2`, see `TriggerEventsDlg.cpp`'s `GetEventParamStart`); `[Actions]`
lines are fixed at exactly 8 fields per action
(`count,type1,p1..p7,type2,...`, `TriggerActionsDlg.cpp`); `[Tags]` lines
are `repeatType,triggerId,tagName`; `[CellTags]` values are just the tag
name directly, keyed by the same packed cell index Waypoints/Terrain use.
The param-code→UI-widget mapping itself wasn't traced to source (likely
resource/dialog-template driven, not plain C++ control flow) — a future
pass scoping this phase in detail should chase that down.

**Newly identified gap: TeamTypes/TaskForces/Scripts are a distinct,
sizeable AI-scripting surface this plan doesn't cover at all**, separate
from map Triggers proper. `[TeamTypes]`/`[TaskForces]`/`[ScriptTypes]` are
**not** flat comma-line sections like everything else — they're
index→ID lookup sections where each ID's actual data lives in its own
separate named section (e.g. `[TeamTypes]` maps an index to `"TeamID001"`,
whose full definition — name, house, task-force reference, script
reference, member unit list, veterancy, waypoint — lives in a section
literally named `[TeamID001]` with named keys, not positional fields;
confirmed at the real editor's `TeamTypes.cpp:363-395`). This needs its own
"read this ID, then look up and parse its own named section" parsing
pattern, not the fixed-comma-index pattern every other object type uses.
**Confirmed: `src/data/MapFile.ts` has zero references to `TeamType`/
`TaskForce`/`ScriptType` today** — this isn't lossy handling, it's a
complete gap; `[TeamTypes]`/`[TaskForces]`/`[ScriptTypes]` sections just sit
untouched in the generic `IniFile.sections` map like any other
editor-doesn't-model section (round-trips fine as long as nothing edits
them, per §3.4/§5's round-trip-fidelity point, but there's no reader for
this data at all today). Worth scoping as its own follow-up before Phase 3
commits to a specific trigger-editing design, since a map with AI-controlled
skirmish opponents will have real `[TeamTypes]`/`[TaskForces]`/`[Scripts]`
content that a trigger UI referencing team types (per `FAData.ini`'s
`ActionsRA2` param code `7`, "team-type reference") would need to resolve
(`TeamTypes.cpp` at 29K is one of the largest files in the whole real
editor, so this is not a small feature to add later).

**Phase 4 — Lighting tuning, map bootstrap (new map / resize / theater
switch), polish.** Straightforward given Phases 1–3; `MapLighting` and
`Lighting.compute()` (see `docs/rendering-lighting-vxl-reference.md`) already
give live WYSIWYG lighting preview essentially for free once an editable
map model exists.

**New-map bootstrap now has a real, authoritative default to use instead of
inventing one.** The real editor's `CMapData::New(...)` doesn't hand-build
default INI content — it loads a template file,
`MissionEditor/data/FinalAlert2/StdMapRA2.ini`, then programmatically
overwrites only `[Map]`'s `Size`/`Theater`/`LocalSize` (`LocalSize` computed
as a fixed margin: `2,4,{width-4},{height-6}` from the full map rect — 2
left/4 top/4 right/6 bottom). That template file's `[Basic]`/`[Lighting]`/
`[SpecialFlags]` content (ambient `1.0`, level `0.032`, `TiberiumGrows=yes`,
etc. — the file's own header comment notes `[Map]` itself is intentionally
absent since the tool always generates it programmatically) is the literal,
correct seed content for this repo's own "new map" bootstrap once Phase 4 is
built — no need to guess reasonable lighting/gameplay-flag defaults.

**Newly identified gap: no undo design exists in this plan at all.** The
real editor's undo system (`MapData.cpp`, `SNAPSHOTDATA* m_snapshots`
ring buffer) stores rectangular bounding-box snapshots of the raw terrain/
overlay grid (`fielddata[]`) only — it does **not** cover object placement
or deletion at all (structures/units/infantry live in separate arrays never
touched by `Undo()`). This is a reasonable, cheap pattern to borrow
directly for Phase 2 terrain/overlay undo (bounding-box snapshot capture
around each brush stroke), but Phase 1 object placement needs its own,
different undo approach — the natural fit given this repo's clean
`game.spawnObject`/`unspawnObject` primitives (§3.1-3.2) is recording
add/remove/move operations as an explicit undo stack, not attempting to
reuse the terrain snapshot approach for objects.

**Other real-editor feature categories this plan has no phase for yet**,
noted for completeness rather than urgency — none of these block Phases
1-4: **tunnel/tube editing** (`Tube.cpp`/`TubeTool.cpp` — a real,
headline-featured RA2 map mechanic for infantry tunnel networks, entirely
outside this plan's scope today); **dedicated map validation**
(`MapValidator.cpp`, 11K — likely covers things like unreachable areas or
missing starting locations; this plan has no equivalent concept at all);
**bitmap-to-map import** (`Bitmap2MapConverter.cpp` — a heightmap-from-image
terrain generator, a nice-to-have feature idea, not a gap in what this plan
already promises).

**One Phase 1 risk this research likely resolves rather than confirms**:
the real editor's `Houses.cpp` was checked specifically for any
`"Multi1".."Multi8"` multiplayer-slot-placeholder naming convention (this
plan's earlier "open risk" note worried a saved map might need to
round-trip such placeholder owners) — **no such string exists anywhere in
FA2's source**. The real editor always works with concrete house/country
names via its own "prepare houses" step. That placeholder-slot convention,
if real at all, is most likely a runtime-only concept the actual game
engine applies when resolving multiplayer slot assignments dynamically —
not something ever written into a `.map` file by the editor that authors
it. This meaningfully de-risks Phase 1 step 6's house/owner-bootstrap
concern for editor-authored maps specifically, though it doesn't rule out
encountering such names in a *live-game-exported* map.

## 5. Biggest open risks

- **Round-trip fidelity on sections we don't model — now has real
  supporting evidence, not just a hopeful assumption.** The whole "Phase 1
  ships before terrain/trigger support exists" claim (§3.4) depends on
  `IniSection.toString()` faithfully reproducing byte-for-byte (or at least
  functionally-equivalent) text for sections the editor never touches. The
  real editor's own save path (`CMapData::UpdateIniFile`, `MapData.cpp:482`)
  works exactly this way: each `Update*(TRUE)` call writes only into its own
  section(s) of a long-lived, session-persistent `m_mapfile`, and sections
  the mapper never touched (Triggers, Tags, VariableNames, ...) are never
  rebuilt on save — this is literally how the original tool works, not a
  convenience assumption unique to this repo. Should still be explicitly
  tested here regardless — load a real official map, `toString()` it
  immediately with zero edits, and diff against the original — before
  relying on it for user-facing save; also worth noting the real editor's
  own "map digest" is *not* a content checksum (it's a lazily-generated
  random per-session ID, `MapData.cpp:1109-1140`), so there's no existing
  precedent to lean on for detecting corruption beyond the diff test itself.
- **LZO/Format80 encoder correctness — mostly retired now, two risks
  remain.** Both encoders exist now (§2.2) and pass round-trip tests against
  this codebase's own decoder, including on real map data. The chunk-framing
  format (§3.4) is now confirmed byte-for-byte against the real editor's own
  `encode5`/`t_pack_section_header` — that risk is closed. `Format80.encode`
  is also confirmed to emit a **valid strict subset** of the real encoder's
  command space (`encode80` in the real editor uses LZ77-style
  back-reference copies this repo's encoder never emits, only literal-copy
  and RLE-fill commands) — not a correctness bug, just a known,
  already-documented output-size inefficiency, not worth fixing unless
  output size specifically matters later. What's *still* open: (1) whether
  the real game engine's own decoder (as opposed to FinalAlert's, which
  should be closely related but isn't proven identical) accepts bytes these
  encoders produce — test against the actual game or CNCMaps Renderer
  before shipping edited terrain to real players; (2) the `IsoMapPack5`-
  specific-encoder question raised in §3.4 (`EncodeIsoMapPack5` may not be
  a plain call into the generic LZO path) — resolve that before trusting
  `MiniLzo.compress()` directly for real terrain writes specifically
  (overlay writes via `Format80.encode` aren't affected by this question).
- **Full-atlas-repack cost, confirmed rather than assumed.** §3.3's Tier 1
  (UV-only patch) only helps when the new tile's art is already in the
  atlas. Reading `TextureAtlas.pack()` directly confirmed Tier 2 isn't "a
  bit more work per tile" — `GrowingPacker` allocates fresh and can reflow
  *every* block's position, so introducing one new drawable means
  recomputing and rewriting UVs for every tile in the map, plus swapping
  `material.map`. Height/`z` changes (moving a tile's world position via
  `Coords.tile3dToWorld`) are excluded from Phase 2 v1 entirely (§4's design
  decision 1) rather than routed through Tier 2, since v1's
  `TileCollection.repaintTile()` doesn't touch `z` at all. Phase 2 v1 should
  be comfortably fast as a result (Tier 1 only, no full-map operations) —
  the risk is scoped specifically to a *future* Tier 2 pass, not v1 as
  planned in §4.
- **Structure field data loss — now concrete, not hypothetical.** The
  parsing/serialization fix (§2.2) captures every field, but
  `aiSellable`/`aiRebuildable`/`upgradeCount`/`spotlight`/`upgrades`/
  `flag3`/`flag4` have no live `GameObject` representation today — a
  structure loaded from a real map and never touched by the editor will
  still lose these fields on save, because `Game.ts`'s
  `createInitialMapTechnos()` only reads them once at boot and never stores
  them back onto the object it creates (see §2.2's write-up and
  `GameObjectMapSerializer.ts`'s own comment on this). Needs either (a)
  `Game.ts` stashing the original values onto the `GameObject` at load time,
  or (b) a genuinely separate editable-model layer (§3.2) that doesn't lose
  fidelity by routing everything through a live `GameObject` in the first
  place — deferred rather than fixed speculatively, since Phase 1's editor
  doesn't expose editing any of these fields either way.
- **Scope of "real in-game rendering."** The core ask (real WorldScene
  lighting/shadows/VXL in the editor) is essentially free once Phase 1's
  scene-hosting works, since it's the same renderer gameplay already uses —
  but live gameplay systems that have no meaning in an editor (combat, AI,
  fog of war, superweapons) need to be explicitly suppressed/no-op'd in the
  editor's `Game` instance, similar to how `MapSnapshotRenderer.
  removeStartingUnits()` already strips default match setup. Getting this
  suppression list right (and keeping it right as gameplay code evolves)
  is an ongoing maintenance surface, not a one-time cost.
