# RA2 Rendering, Lighting, and VXL Reference

This document explains how the *real* Red Alert 2 / Yuri's Revenge engine renders
terrain, lighting, and voxel (VXL) models, learned from reading the
[CNCMaps Renderer](https://github.com/CnCNet/cncmaps-net) source (a mature,
open-source C# tool that renders official `.map` files using the game's actual
rules-driven lighting and voxel pipeline — checked out locally at
`~/development/my-experiment/ccmaps-net/`). It then cross-references each
mechanism against this repo's TypeScript/Three.js reimplementation, noting
where we match, where we deliberately take a real-time shortcut, and where a
real fidelity gap might be worth investigating.

CNCMaps is an **offline batch renderer**: it loads a whole map, resolves every
palette and light source once, rasterizes everything (via a small software
rasterizer for voxels — see below) and writes one PNG. It is not a game
engine and has no per-frame animation, camera movement, or dynamic light
sources. Its value here is that it reimplements the *classic* lighting and
voxel-shading math faithfully, giving us ground truth independent of the
Chronodivide/ra2web.com JS bundle (which is itself a from-scratch
reimplementation and can share our bugs rather than the original game's
behavior).

## 1. Palette-based lighting model

### The core idea: everything is a recolored palette, not a lit pixel

The classic engine has no per-pixel lighting pass. Every drawable object
(terrain tile, building, unit, overlay) is 8-bit paletted art. "Lighting" an
object means computing a *different 256-color palette* for it and using that
palette when blitting its sprite. `CNCMaps.Engine/Rendering/Palette.cs`:

```csharp
double _redMult = 1.0, _greenMult = 1.0, _blueMult = 1.0, _ambientMult = 1.0;

public void ApplyLighting(Lighting l, int level = 0, bool applyTints = true) {
    _ambientMult = l.Ambient - l.Ground + l.Level * level;
    if (applyTints) {
        _redMult = l.Red;
        _greenMult = l.Green;
        _blueMult = l.Blue;
    }
}

public void ApplyLamp(LightSource lamp, double lsEffect, bool ambientOnly = false) {
    _ambientMult += lsEffect * lamp.LightIntensity;
    if (!ambientOnly) {
        _redMult += lsEffect * lamp.LightRedTint;
        _greenMult += lsEffect * lamp.LightGreenTint;
        _blueMult += lsEffect * lamp.LightBlueTint;
    }
}

public void Recalculate() {
    const double clipMult = Double.MaxValue; // ceiling disabled by CNCMaps' maintainer
    _ambientMult = Math.Min(Math.Max(_ambientMult, 0), clipMult);
    _redMult   = Math.Min(Math.Max(_redMult, 0), clipMult);
    _greenMult = Math.Min(Math.Max(_greenMult, 0), clipMult);
    _blueMult  = Math.Min(Math.Max(_blueMult, 0), clipMult);
    for (int i = 0; i < 256; i++) {
        double rmult = _ambientMult * _redMult;
        double gmult = _ambientMult * _greenMult;
        double bmult = _ambientMult * _blueMult;
        var r = (byte)Math.Min(255, _origColors[i*3+0] * rmult / 63.0 * 255.0);
        // ...g, b identical
        Colors[i] = Color.FromArgb(r, g, b);
    }
}
```

The key structural fact: **every light source that can reach an object adds a
small delta to one shared multiplier for that object's palette. The combined
total is clamped exactly once (floor at 0, no ceiling), and only then is it
multiplied into the base palette colors, once.** Nothing is ever re-applied to
an already-lit color. This additive-then-clamp-once-then-apply-once shape is
the single most important thing to carry over into any reimplementation of
this system — see §4 for why our engine had a bug from not doing this.

`Lighting.cs` (`CNCMaps.FileFormats/Map/Lighting.cs`) is just the parsed
`[Lighting]` map-INI section: `Level`, `Ambient`, `Red`, `Green`, `Blue`,
`Ground`. `Ambient` is the map's overall daylight brightness; `Ground` is
subtracted from it (a permanent "floor" darkening independent of light
sources — used for underground/tunnel-style theaters); `Level` is a
per-height-step brightness gradient (taller tiles are lit slightly
differently), applied as `l.Level * level` where `level` is the tile's Z step
(0–18).

### How light sources are discovered and applied (`Map.cs`)

```csharp
private void LoadLightSources() {
    foreach (StructureObject s in _structureObjects.ToList()) {
        var section = _rules.GetSection(s.Name);
        if (section != null && section.HasKey("LightVisibility")) {
            var ls = new LightSource(_rules.GetSection(s.Name), _lighting);
            ls.Tile = s.Tile;
            _lightSources.Add(ls);
        }
    }
}

private void ApplyLightSources() {
    foreach (LightSource lamp in _lightSources) {
        foreach (MapTile t in _tiles) {
            if (!lamp.ApplyLamp(t)) continue; // out of range -> skip
            foreach (var obj in t.AllObjects.Where(o => o.Lighting == LightingType.Full || o.Lighting == LightingType.Ambient))
                lamp.ApplyLamp(obj, obj.Lighting == LightingType.Ambient);
        }
    }
}
```

Any structure whose rules.ini section has a `LightVisibility` key becomes a
light source — this is exactly how `NEGRED`/`NEGLAMP` ("Negative Light Post")
objects work; there is no separate "is this a light" flag, `LightVisibility`
presence *is* the flag. Per light source, the renderer walks **every tile on
the map** and applies the lamp if in range — and, critically, *also* applies
it to every object standing on that tile with `Lighting == Full` or
`Ambient`. **Buildings and units sitting inside a light source's radius get
tinted along with the ground beneath them** — there is no "objects are immune
to ambient light effects" exception anywhere in this path.

The per-tile falloff, from `GameObjects.cs`'s `LightSource.ApplyLamp`:

```csharp
double distance = Math.Sqrt(sqX + sqY); // rx/ry tile-space distance
if ((0 < lamp.LightVisibility) && (distance < lamp.LightVisibility / 256)) {
    double lsEffect = (lamp.LightVisibility - 256 * distance) / lamp.LightVisibility;
    obj.Palette.ApplyLamp(lamp, lsEffect, ambientOnly);
}
```

`LightVisibility` is in leptons (256 leptons = 1 cell), and `lsEffect` is a
**linear** falloff from `1.0` at the lamp's exact tile to `0.0` at
`LightVisibility/256` cells away — measured in rx/ry (the map's internal
rotated tile-coordinate space), not screen-space or true Euclidean world
distance. There is no falloff curve beyond linear; no inverse-square, no
smoothstep.

Palettes are also heavily **shared** for efficiency: `Map.cs`'s
`CreateLevelPalettes()` precomputes one palette per Z-height-step (19 total)
for plain terrain tiles, since most tiles at the same height with no local
light source can share one palette object. A tile only gets its own private
palette once a light source actually reaches it (`Palette.Clone()`,
triggered lazily in `ApplyLamp`/`ApplyLighting`). `LoadPalettes()` in `Map.cs`
shows the object/tile palette-selection logic in full, including a
`PaletteType`/`LightingType` combination table per drawable.

### How our engine compares

`src/engine/Lighting.ts` already implements a lighting accumulator with
**exactly the same additive-per-tile shape** as CNCMaps:

```ts
addTileLight(tile: string, light: TileLight) {
    if (!this.tileLights.has(tile)) this.tileLights.set(tile, new Set());
    this.tileLights.get(tile)!.add(light);
}
computeTileLightIntensity(tile: string): number {
    let intensity = 0;
    for (const light of this.tileLights.get(tile) ?? []) intensity += light.intensity;
    return intensity;
}
compute(type, tile, height = 0): THREE.Vector3 {
    return this.computeTint(type)
        .add(this.computeTileTint(tile, type, new THREE.Vector3()))
        .multiplyScalar(this.mapLighting.ambient + this.mapLighting.ground
            + this.computeLevel(type, tile.z + height)
            + this.computeTileLightIntensity(tile));
}
```

This is a genuinely close structural match to `Palette.ApplyLamp`/
`Recalculate` — additive accumulation per tile, summed once, applied once.
**However, it is only wired up for one thing: Tiberium/radiation-field
tinting**, via `MapRenderable.ts`:

```ts
const lightData = {
    intensity: this.rules.radiation.radLightFactor * intensity,
    red: (radColor[0] / 255) * intensity, /* ... */
};
this.lighting.addTileLight(tile, lightData);
```

**Update:** at the time this section was first written, `Building.ts`'s
`createLamp()` — the code path responsible for `NEGRED`/`NEGLAMP`-style
light-post objects — did **not** use this accumulator at all, instead
rendering each light-post as an independent GPU alpha-blended plane directly
over the already-rendered scene. That's since been fixed: `createLamp()` now
calls `addTileLight`/`removeTileLight` directly (computing the affected tile
set and each tile's `lsEffect` via the exact `GameObjects.cs`
`LightSource.ApplyLamp` linear-falloff formula from §1), so building light
sources and Tiberium radiation now share the one accumulator. See §4 for
the bug this fixed and why the unified design is correct.

## 2. VXL (voxel) rendering and shading

### File formats

A `.vxl` file (`CNCMaps.FileFormats/VxlFile.cs`) holds one or more named
**sections** — typically `body`, `turret`, `barrel` for a vehicle — each a
sparse 3D grid of voxels. Each voxel stores a palette color index and a
**normal index** (a byte, looked up in a small fixed table of ~244 possible
surface normal directions the format supports):

```csharp
public class Voxel {
    public byte X, Y, Z;
    public byte ColorIndex;
    public byte NormalIndex;
}
```

A `.hva` file (`HvaFile.cs`) stores, per section, one 4×4 transform matrix
**per animation frame** — this is what lets a turret section rotate
independently of the body, or a barrel recoil, using the same mechanism as a
skeletal-animation bone hierarchy: `hva.LoadGLMatrix(section.Index)` gives
the section's current local transform, which `VxlRenderer` composes with the
object's own world/facing/tilt matrices.

### CNCMaps' renderer: a real (if simple) software rasterizer

`VxlRenderer.cs`'s docstring explains its own design:

> Renders voxel models to an offscreen surface using a small software
> rasterizer. This replaces the former OpenGL implementation with equivalent
> semantics (fixed-function pipeline, flat-shaded quads, depth-test less), so
> no GPU or OpenGL driver is required and output is identical on every
> machine.

Each voxel becomes a unit cube (6 quads = 12 triangles), transformed through
a full model-view-projection matrix chain that reproduces the *original
game's* fixed dimetric camera (elevated 30°, `orthoDiameter = 10.7157`,
derived from the historical perspective camera's FOV/eye-distance at the
model's depth) and rasterized with its own tiny triangle rasterizer,
including a proper `float[] _zBuffer` for correct occlusion between
overlapping voxels/sections (depth-test "less", matching old GL defaults).
Two full projection passes happen per object: the normal one, and a second
one with the Z basis vector zeroed out (`flatten.M33 = 0`) that flattens the
same geometry onto the ground plane to rasterize its **shadow silhouette**
(see §3).

### Per-voxel shading: two paths, `.vpl` or Lambert fallback

This is the most interesting part for lighting fidelity. The classic game
does **not** compute continuous per-pixel lighting for voxels. Instead, a
`voxels.vpl` file is a lookup table: for each of a small number of "lighting
pages" (buckets of overall brightness), it remaps every one of the 256
palette colors to a pre-shaded variant. Rendering a lit voxel is: figure out
which lighting page this voxel's normal+facing combination falls into, then
substitute the palette color through that page.

```csharp
byte remapped = _vpl.GetPaletteIndex(vplPages[vx.NormalIndex], vx.ColorIndex);
Color color = obj.Palette.Colors[remapped];
```

`PreCalculateVplLighting` computes, once per object per frame, which VPL page
every one of the ~244 possible normals maps to, using a Blinn-Phong model
reverse-engineered by the WorldAlteringEditor project (light direction
depends on engine — RA2/YR use a 45°-rotated light vs. TS):

```csharp
float diffuse = Math.Max(Vector3.Dot(normalsTable[i], light), 0f);
float halfwayDot = Vector3.Dot(normalsTable[i], halfway);
float specular = halfwayDot / (specularStrength - halfwayDot*specularStrength + halfwayDot);
pages[i] = (byte)Math.Clamp((diffuse + specular) * 16.0f, 0f, 255f);
```

So even the "correct" path is fundamentally **quantized**: normals get
bucketed into a handful of discrete lighting pages, not a continuous
gradient. If no `.vpl` is available, CNCMaps falls back to a plain
Ambient+Lambert term computed directly in float and multiplied onto the
palette color (`Ambient = 0.8`, `Diffuse = 1.3`, both flat constants tuned to
visually match what the VPL table already bakes in) — this is the path this
repo's engine effectively always uses (see below), since it has no VPL
lookup table at all.

### Player-color remapping

Voxels don't get a separately-computed remap; they reuse the **same**
per-object `Palette` that terrain/SHP rendering already remapped for house
color (`Map.cs`'s `ApplyRemappables()`, calling `Palette.Remap(color)` — see
`Palette.cs`'s `Remap()`, which overwrites indices 16–31, the game's
reserved "remap ramp", with shades of the player's house color). Voxel
shading just indexes into whichever palette (remapped or not) the object
already carries, exactly like 2D SHP sprites do.

### How our engine compares

`src/data/VxlFile.ts`/`src/data/HvaFile.ts` parse the same file formats
(voxel sections + per-frame HVA transforms), and `VxlBuilder.ts` composes
them the same way — an `Object3D` per section with its own HVA-driven local
transform, exactly mirroring `VxlRenderer`'s per-section MVP composition (see
`VxlBuilder.build()`'s `rotationContainer`/section-mesh hierarchy).

Where our engine diverges meaningfully: instead of CPU-rasterizing cubes with
VPL-quantized lighting pages, `VxlGeometryMonotoneBuilder.ts` (and its
sibling naive/culled builders) greedy-mesh the voxel grid into real GPU
geometry once, and shading happens continuously at render time via
`PalettePhongMaterial` (`src/engine/gfx/material/PalettePhongMaterial.ts`) —
a custom shader built by patching Three.js's own built-in Phong shader chunks
(`THREE.ShaderChunk.meshphong_frag`) to source diffuse color from a **palette
texture** instead of a flat material color:

```ts
fragmentShader: THREE.ShaderChunk.meshphong_frag
    .replace("#include <common>", "#include <common>\n" + paletteShaderLib.paletteColorParsFrag)
    .replace("#include <color_fragment>", "#include <color_fragment>\n" + paletteShaderLib.paletteColorFrag)
    .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\n" + paletteShaderLib.paletteFullLightFragment),
```

This means our voxels are lit by Three.js's **real, continuous** Phong
lighting model, driven by `WorldScene`'s actual `THREE.DirectionalLight` +
`THREE.AmbientLight`, reacting smoothly to true per-pixel surface normals
rather than being bucketed into a handful of `.vpl` pages. This is a
deliberate, reasonable real-time upgrade — smoother-looking, and it means our
lighting reacts correctly to actual dynamic light changes (day/night,
ambient shifts) that the classic engine's precomputed VPL pages can't express
per-frame at all. `extraLight` (`material.extraLight`, a `THREE.Vector3`
uniform) plays the same role as CNCMaps' object-level palette
remap/highlight tinting (e.g. selection glow, cloak fade) without needing a
palette clone.

**Fidelity gap worth flagging:** because we never load `voxels.vpl` and never
implement the page-bucketing/Blinn-Phong-page model, our voxel shading will
never exactly match a screenshot from the real game or from CNCMaps' output
pixel-for-pixel, even though it's visually close. This is very unlikely to
matter for gameplay, but would matter if this project ever wanted a
"golden-image" pixel-diff test against real game screenshots (CNCMaps itself
has exactly such `GoldenRenderTests.cs` — worth a look if that's ever wanted
here).

## 3. Shadow rendering

The classic engine has **two separate, unrelated shadow techniques** — one
per rendering path — and this repo mirrors that split closely.

### SHP sprites (infantry, most buildings/terrain, 2D animations): baked shadow frames

There is no shadow *computation* here at all. Every SHP art file that has a
shadow simply **contains its own shadow images baked into the second half of
its frame list** by the original artists, at a fixed light angle matching
that theater's lighting. `ShpRenderer.cs`:

```csharp
frameIndex += shp.Images.Count / 2; // latter half are shadow Images
// ...
*(w + 0) /= 2; *(w + 1) /= 2; *(w + 2) /= 2; // halve destination RGB
shadows[zIdx] = true; // never darken the same pixel twice
```

Drawing a shadow is: pick the mirrored frame index, and wherever that
shadow-frame pixel is opaque, halve the already-drawn destination pixel's
RGB — gated by a per-pixel boolean "already shadowed" buffer (so two
overlapping units' shadows don't double-darken the same spot) and a height
check (`CastsOver`) so a shadow never darkens something taller than its
caster (e.g. a tank shadow shouldn't fall across a building behind it that's
actually elevated above the shadow plane).

Our repo's `ShadowRenderable.ts` is a direct, faithful port of exactly this
technique: it indexes into the same "latter half of the SHP" shadow frames
(`computeShadowFrameNo`/`frameHasShadowData`) and renders them through an
all-zero (`new Array(768).fill(0)`) palette — i.e. pure black — via a real
transparent-blended mesh instead of a CPU pixel-halving blit. Same baked
data, same selection logic, GPU-blended instead of CPU-blitted.

### VXL objects (vehicles, aircraft): projected silhouette, computed per frame

Voxel shadows are **not** baked; `VxlRenderer.Render()` computes them
dynamically every render by literally re-rasterizing the same voxel geometry
flattened onto the ground plane:

```csharp
// shadow: flatten the model onto the ground plane (z=0 in upright world
// space, i.e. after the model/facing/tilt transforms but before the
// camera transforms), then project to screen like regular geometry.
var flatten = Matrix4x4.Identity;
flatten.M33 = 0f;
var shadowMvp = MatrixMath.Mul(frame, @object, flatten, world, trans, lookat, persp);
```

This produces a boolean silhouette buffer (`shadBuf`), which
`VoxelDrawable.BlitVoxelToSurface` composites with the **same** halve-RGB /
already-shadowed-buffer / height-check technique as the SHP path above — the
two paths converge on identical final compositing semantics even though the
shadow *shape* is computed completely differently (baked art vs. live
silhouette projection).

### How our engine compares

Our engine doesn't reproduce CNCMaps' CPU silhouette-flattening technique for
VXL shadows. Instead, `WorldScene.ts` sets up a real Three.js shadow map on
its one `THREE.DirectionalLight`:

```ts
light.castShadow = enableShadows;
shadowCamera.right = shadowSize; shadowCamera.left = -shadowSize; // ...
light.shadow.mapSize.width = 1024 * shadowMapMultiplier; // ShadowQuality Low/Medium/High
```

`ShadowQuality` (`Off`/`Low`/`Medium`/`High`) scales the shadow map
resolution multiplier (2/4/8). This is a genuinely different mechanism (a
real depth-map shadow, filtered by GPU hardware, vs. a boolean
CPU-rasterized silhouette) but aims at the same visual result — a shadow cast
by the same directional light used for regular shading — and, being a real
shadow map, naturally handles self-shadowing and correct occlusion between
multiple 3D objects without needing CNCMaps' explicit height-comparison
hack.

Airborne or paradropping units additionally get `BlobShadow.ts` — a flat,
constant-opacity circle (`THREE.CircleGeometry`, `opacity: 0.5`) drawn
directly beneath them on the ground plane, visible only while
`zone === Air` or during a paradrop stance. This has no direct CNCMaps
equivalent; it's a practical real-time simplification for a case (a unit
significantly above the ground plane) where a directional shadow map would
either miss the unit or produce a shadow shape that reads badly at a distance
— the classic engine doesn't render flying units with real-time-adjustable
elevation at all, so this situation simply didn't arise for it the same way.

**Fidelity gap worth flagging:** none of major concern found here — both
paths (SHP baked-frame port, VXL real shadow-map instead of CPU silhouette)
are reasonable, deliberate adaptations rather than accidental divergences.

## 4. Case study: the `NEGRED`/`NEGLAMP` darkening bug

This reference document was produced immediately after diagnosing and fixing
a concrete bug caused by not following §1's additive-accumulate-once
pattern, which is worth recording here as a live example of why the pattern
matters.

`Building.ts`'s `createLamp()` used to render each light-post's effect as an
independent alpha-blended plane drawn directly over the already-rendered
scene (`blending: THREE.CustomBlending`, `blendEquation: ReverseSubtractEquation`
for negative-intensity lights, `blendSrc: DstColorFactor`, `blendDst:
OneFactor`) at a very high `renderOrder` so it always drew last. Two
consequences followed directly from not matching CNCMaps' model:

1. Because it re-blended the *already-composited* destination color once per
   overlapping light source (rather than summing contributions once and
   applying the total once), overlapping lights **compounded
   multiplicatively** instead of additively. A map with several large-radius
   `NEGLAMP` posts placed close enough to overlap could — and on one real
   community map did — compound down to literal `(0, 0, 0)` once 8-bit GPU
   blending rounded a small enough value to zero.
2. Because it drew directly onto the finished scene at a fixed high
   `renderOrder`, it could paint over buildings and units standing in the
   affected area, making them appear to vanish — whereas CNCMaps' model
   (§1) tints *every* object on the affected tile via its own palette, so
   objects are dimmed along with the ground, never erased.

The first fix attempt reproduced CNCMaps' accumulate-once-clamp-once shape
as a parallel GPU mechanism (an offscreen darkness-accumulation pass plus a
composite shader), which worked but left two lighting pathways with
different failure modes. The final fix instead deletes that mesh/GPU path
entirely and routes light-posts through `Lighting.ts`'s existing
`tileLights` accumulator (§1) — the same one radiation already uses:
`createLamp()` now walks every tile within `LightVisibility/256` cells of
the object's own tile — scanning rx/ry directly via `TileCollection
.getByMapCoords`, rejecting tiles outside the radius by squared distance
before paying for a sqrt or a tile lookup, mirroring `LightSource
.ApplyLamp`'s Euclidean rx/ry falloff exactly — and calls `addTileLight`/
`removeTileLight` per tile instead of building any mesh. `Lighting.compute()`
gained the missing `Math.max(x, 0)` floor
clamps (on both the ambient scalar and the combined tint) to match
`Palette.Recalculate()` exactly. This is a net simplification — no new
render target, shader, or Three.js layer needed — because it uses the
mechanism the engine already had for exactly this kind of effect. It also
fixes a rendering-technique mismatch that both the old code and upstream
shared: light-post objects (frequently `InvisibleInGame=yes`) have **no
visible mesh of their own** in real RA2 — the "light" is purely the tile
recolor. Drawing a glow/darkening decal at all, however blended, was never
the correct picture.

## Open questions / fidelity gaps worth investigating later

- ~~`Lighting.ts`'s `tileLights` accumulator is under-used~~ — fixed: building
  light-posts now route through it (§1, §4). Other per-object ambient
  effects that might still warrant a look: none identified in this pass,
  but worth keeping in mind if a similar "draws its own decal" pattern
  turns up elsewhere.
- **No VPL-page-quantized voxel lighting.** Our engine's continuous
  real-time Phong shading for VXL models will never pixel-match the real
  game or CNCMaps' output. Almost certainly fine for gameplay; would matter
  for a golden-image regression test (CNCMaps has `GoldenRenderTests.cs` as
  precedent if that's ever wanted).
- **VXL shadows use a real shadow map, not a CPU silhouette projection.**
  Visually reasonable, but means our voxel shadow *shape* is governed by
  Three.js's shadow-map filtering/bias settings rather than an exact
  re-projection of the model — worth a visual spot-check on a few
  distinctive vehicle silhouettes (e.g. long-barreled units) if shadow
  fidelity is ever scrutinized closely.
- **`Ground` and `Level` lighting.ini fields**: confirmed present and wired
  in both engines (`_ambientMult = l.Ambient - l.Ground + l.Level * level`
  vs. `Lighting.ts`'s `mapLighting.ambient + mapLighting.ground +
  computeLevel(...)`), but this document didn't verify a numeric side-by-side
  on a real map with non-default `Ground`/`Level` values — worth a quick
  sanity check if a theater with unusual lighting.ini values ever looks off.
- **CNCMaps' `Recalculate()` ceiling clamp is dead code** (`clipMult =
  Double.MaxValue`, with a comment saying it used to be `1.3` but was
  disabled by the maintainer due to discoloration artifacts). This means the
  *real* reference behavior for very bright overlapping *positive*-intensity
  lights is "no ceiling at all" (colors just clip at 255 per-channel in the
  final byte cast) — our engine's positive/additive lamp path already has no
  ceiling either (`AddEquation`/`DstColorFactor`/`OneFactor`, GPU-saturating
  add), so this one already matches without any special-casing.
