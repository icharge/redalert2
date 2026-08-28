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

**Object sections are also not currently write-safe, for a subtler reason:
lossy parsing, not missing infrastructure.** `readStructures()` only
extracts 7 of a real structure line's ~17 comma-separated fields:

```ts
readStructures(e: IniSection) {
    ...
    structure.owner = values[0];
    structure.name = values[1];
    structure.health = Number(values[2]);
    structure.rx = Number(values[3]);
    structure.ry = Number(values[4]);
    structure.tag = this.readTagId(values[6]);      // facing (index 5) dropped
    structure.poweredOn = Boolean(Number(values[9])); // indices 7,8,10+ dropped
}
```

(Confirmed against a real map earlier this session: `eb4.map`'s structure
lines look like `1028701=Neutral,CAGAS01,256,61,84,0,None,0,0,1,0,0,None,
None,None,0,0` — facing, AI-sellable flags, and the trailing upgrade slots
are parsed by nothing.) A `Structure` instance has no back-reference to its
original raw line, so even a "just write back what didn't change" strategy
would silently drop those fields on re-save today. This is fixable — either
capture the full field tuple when parsing, or keep each object's raw INI
line alongside the parsed convenience fields and only rewrite the specific
fields the editor UI actually changed — but it's real work, not zero.

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

`MapTileLayer` needs a real "repaint this tile" path. Two viable shapes,
roughly in order of engineering cost:

1. **Cheap, works for texture-only changes**: since terrain tiles are drawn
   from a shared `TextureAtlas`, if the new tile's art is already resident
   in the atlas, only the affected sprite's UV rect in the merged geometry's
   `uv` buffer attribute needs updating in place (same technique
   `updateColorMultBufferAtIndex` already uses for the color-mult buffer) —
   no geometry rebuild, no atlas rebuild, as long as `tileIndexes.get(tile)`
   (already tracked) gives a stable vertex-range to patch.
2. **General case (new tile art, e.g. painting in a brand-new tileset
   variant not yet in the atlas, or a height/`z` change that moves the
   sprite's world position)**: requires re-packing the atlas and/or
   rebuilding that tile's quad geometry and splicing it into the merged
   buffer — meaningfully more work, closer to (but hopefully well short of)
   a full rebuild. A pragmatic middle ground: batch edits within one brush
   stroke/frame and rebuild only the tiles touched that stroke, not the
   whole map.

### 3.4 New capability: `.map` serialization

- **Object sections**: fix the lossy-parse gap (§2.2) by capturing full raw
  field tuples per object type, and write a `Structure`/`Vehicle`/... →
  INI-line encoder that only overwrites the fields the editor UI actually
  exposes, preserving everything else byte-for-byte from the original line.
- **Terrain**: the Format80/LZO1X encoders now exist (`Format80.encode`,
  `MiniLzo.compress` — see §2.2) and have passed round-trip fidelity testing
  against real map data. What's still needed for this phase: a `Format5`
  `encode`/`encodeInto` to do the chunk-framing (mechanical — chunk the
  input, call the relevant compressor per chunk, write the 2+2-byte
  size headers), and, separately, the actual mutable-terrain-model work in
  §2.5/§3.3, which the encoder doesn't touch.
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

**Phase 1 — Object placement editor, nearly free.** Build the
`EditorController` + placement-preview + selection/gizmo (§3.1) on top of
the *existing* Scene Sandbox interaction model, targeting only
`[Structures]`/`[Units]`/`[Infantry]`/`[Aircraft]`/`[Terrain]`/`[Smudge]`/
`[Waypoints]`. Fix the lossy structure-line parsing (§2.2) so save doesn't
drop fields. Save = generic `IniFile.toString()` (already works, since
nothing here touches `[IsoMapPack5]`) + `POST /maps/upload` (already
exists, §2.6). This phase alone gets a mapper real WYSIWYG object placement
with zero new compression/mesh-rebuild engineering — genuinely the highest
value-to-effort ratio available.

**Phase 2 — Terrain & overlay painting.** The compression encoders (§3.4)
are done and validated in isolation; what's left is the `Format5` chunk-
framing wrapper (mechanical) and the real work: incremental `MapTileLayer`
updates (§3.3) and making `TileCollection` mutable (§2.5) so there's
somewhere to call the encoder from. Overlay painting (ore/walls) follows the
same shape once terrain works.

**Phase 3 — Trigger/tag/AI scripting UI.** The largest, most RA2-specific
surface (event/action pairing, tag linking, cell tags, variables, base/AI
triggers) and the one most likely to desync from the actual game logic's
interpretation of these structures if the UI's model of "what a trigger
means" drifts from `TriggerReader`'s. Start from `TriggerReader`/`TagsReader`
/`CellTagsReader`'s parsed model as the UI's data model directly (don't
reinvent a parallel trigger representation), and keep raw round-trip
fidelity as the fallback for anything the UI doesn't yet expose editing for.

**Phase 4 — Lighting tuning, map bootstrap (new map / resize / theater
switch), polish.** Straightforward given Phases 1–3; `MapLighting` and
`Lighting.compute()` (see `docs/rendering-lighting-vxl-reference.md`) already
give live WYSIWYG lighting preview essentially for free once an editable
map model exists.

## 5. Biggest open risks

- **Round-trip fidelity on sections we don't model.** The whole "Phase 1
  ships before terrain/trigger support exists" claim (§3.4) depends on
  `IniSection.toString()` faithfully reproducing byte-for-byte (or at least
  functionally-equivalent) text for sections the editor never touches. This
  should be explicitly tested — load a real official map, `toString()` it
  immediately with zero edits, and diff against the original — before
  relying on it for user-facing save.
- **LZO/Format80 encoder correctness — partially retired, one risk remains.**
  Both encoders exist now (§2.2) and pass round-trip tests against this
  codebase's own decoder, including on real map data. What's *not* yet
  verified: whether the real game engine, FinalAlert, or CNCMaps Renderer
  can decode bytes these encoders produce. It's possible for two decoders to
  agree with each other while both are slightly more permissive than the
  original format spec — e.g. if this repo's decoder accepts a byte pattern
  the real game's decoder would reject. Test against the actual game or
  CNCMaps before shipping edited terrain to real players.
- **Full-map mesh rebuild cost, worst case.** §3.3's cheap path (UV-only
  patch) only helps when the new tile's art is already in the atlas and its
  world position doesn't change. A mapper doing large-area terrain
  reshaping (changing height `z`, which shifts world position per
  `Coords.tile3dToWorld`) may hit the expensive full-rebuild path often
  enough that per-stroke (not per-tile) rebuild batching (§3.3) is load-
  bearing for the tool to feel responsive, not just a nice-to-have.
- **Structure field data loss.** Even after the Phase 1 parsing fix, any
  object field the UI doesn't expose (the AI/upgrade tail fields noted in
  §2.2) needs a policy: preserve-verbatim-if-unedited is achievable, but
  requires discipline to not accidentally re-derive/reset those fields
  anywhere in the write path.
- **Scope of "real in-game rendering."** The core ask (real WorldScene
  lighting/shadows/VXL in the editor) is essentially free once Phase 1's
  scene-hosting works, since it's the same renderer gameplay already uses —
  but live gameplay systems that have no meaning in an editor (combat, AI,
  fog of war, superweapons) need to be explicitly suppressed/no-op'd in the
  editor's `Game` instance, similar to how `MapSnapshotRenderer.
  removeStartingUnits()` already strips default match setup. Getting this
  suppression list right (and keeping it right as gameplay code evolves)
  is an ongoing maintenance surface, not a one-time cost.
