# VXL Shader Rendering — Upstream Parity Notes

This document explains how VXL (voxel) vehicles are lit in this engine, why the
port originally rendered them darker than the upstream JS game, and exactly what
was changed to restore parity.

Reference upstream: the bundled `downloaded-game-js` build, which uses
**three.js r94** with **no color management at all** and **no
`physicallyCorrectLights`** option.

## 1. The rendering pipeline

VXL geometry is built per-section (`VxlGeometryMonotoneBuilder` etc. in
`src/engine/renderable/builder/vxlGeometry/`), then rendered with
`PalettePhongMaterial` (`src/engine/gfx/material/PalettePhongMaterial.ts`),
which is a `MeshPhongMaterial` subclass whose vertex/fragment shaders are
custom-built from three's `meshphong_vert`/`meshphong_frag` chunks with the
palette lookup injected (see `src/engine/gfx/material/paletteShaderLib.ts`).

The material is a "palette material": instead of a texture map, each vertex
carries a palette index in its vertex color (`vColor.r`), and the fragment
shader samples a 256-wide palette texture:

```glsl
paletteColorIndex = vColor.r;
diffuseColor = texture2D(palette, vec2(paletteColorIndex, ...));
```

Lighting is then applied on top of the sampled palette color. Because the
engine stores *display-referred* colors in the palette, the lighting math must
reproduce the upstream "raw multiply" behavior.

## 2. Why vehicles were darker

Three cumulative deviations from the upstream build:

### 2.1 Palette textures were marked sRGB

`TextureUtils.textureFromPalBitmap()` set:

```ts
texture.colorSpace = SRGBColorSpace;
```

Upstream leaves palette textures un-encoded (raw). With the sRGB flag, three
r183 decodes the palette color to linear before the shader uses it, so a
mid-gray palette entry (0.5) became ~0.217 in the lighting math and the final
sRGB re-encode only restored the value for *unlit* materials. Lit VXL colors
came out significantly darker.

Fix: removed the flag — palette textures are raw, exactly like upstream.

### 2.2 The renderer had sRGB output + color management enabled

The port explicitly set:

```ts
renderer.outputColorSpace = SRGBColorSpace; // (also the r183 default)
```

and left `THREE.ColorManagement.enabled = true` (the r152+ default). Upstream
r94 has neither:

- renderer outputs raw values (no `outputEncoding`/`outputColorSpace` set),
- hex colors are used verbatim (no sRGB→linear conversion on `new THREE.Color(0x...)`).

Fix in `src/engine/gfx/Renderer.ts`:

```ts
(THREE.ColorManagement as any).enabled = false;   // match r94 raw hex colors
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // no output gamma
```

Notes:

- Unlit sprites (SHP) look identical before and after: previously
  sRGB-decode → unlit pass-through → sRGB-encode was an identity round trip;
  now it is a raw pass-through.
- With color management disabled, the VXL specular color `0x111111` is used
  raw (~0.067) as in r94, instead of being linearized to ~0.004 which made the
  specular highlight invisible.

### 2.3 The custom light fragment math

The original `paletteFullLightFragment` (injected after
`#include <lights_fragment_end>`) deviated from upstream in three ways:

1. It multiplied the direct term by `directionalLights[i].color` and the
   ambient term by `getAmbientLightIrradiance(ambientLightColor)`. Upstream
   *replaces* the light color entirely with the `extraLight` uniform
   (`directLight.color = extraIrradiance`) and ignores the scene ambient color.
2. It missed the r94 PI convention. r94 (without
   `physicallyCorrectLights`) multiplies the irradiance by `PI` inside
   `RE_Direct_*` and `getAmbientLightIrradiance`, and its `BRDF_Diffuse_Lambert`
   is `diffuseColor / PI`. r183 moved the `1/PI` into `BRDF_Lambert` but has no
   PI on the irradiance side, so the standard contributions came out `1/PI`
   (~0.318×) too dim.
3. The specular branch was gated by `#ifdef USE_PHONG`, which is never defined
   anywhere in three — so VXL had no specular highlight at all.

Fix (`paletteShaderLib.ts`, `paletteFullLightFragment`):

```glsl
// compensate r183's RECIPROCAL_PI vs r94's irradiance * PI
reflectedLight.directDiffuse *= PI;
reflectedLight.directSpecular *= PI;
reflectedLight.indirectDiffuse *= PI;

// reproduce upstream: light color replaced by extraIrradiance
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    directLight.direction = directionalLights[ i ].direction;
    directLight.color = extraIrradiance * PI;
    directLight.visible = true;
    RE_Direct( directLight, geometryPosition, geometryNormal,
               geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
  #pragma unroll_loop_end
#endif

// extraIrradiance added to ambient additively, like upstream
#if defined( RE_IndirectDiffuse )
  RE_IndirectDiffuse( extraIrradiance, geometryPosition, geometryNormal,
                      geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
```

Using the per-material `RE_Direct`/`RE_IndirectDiffuse` macros means the
injected code automatically produces the correct specular for
`PalettePhongMaterial` (Blinn-Phong, unconditional) and none for
`PaletteLambertMaterial`, matching upstream's use of `RE_Direct`.

## 3. Resulting lighting math (linear space, raw output)

For a unit with extra-light value `E` (`extraLight` uniform, from
`Lighting.computeNoAmbient` + `ExtraLightHelper.multiplyVxl`):

```
direct diffuse  = dotNL * (lightColor + E) * diffuseColor
direct specular = dotNL * (lightColor + E) * PI * BRDF_BlinnPhong * specularStrength
ambient         = (ambientLightColor + E / PI) * diffuseColor
```

where `lightColor` is white (1,1,1) and `ambientLightColor` is the scene
ambient (game: `ambientIntensity * 0.8`).

## 4. How this was verified

A throwaway WebGL harness (vite dev server + playwright) rendered a
palette-textured sphere with the game's exact light setup
(`AmbientLight(0xFFFFFF, 0.8)` + `DirectionalLight(0xFFFFFF, 1.0)` at the
game's sun position) using the real `PalettePhongMaterial`, and compared
pixel-by-pixel against a CPU reference rasterizer implementing the upstream r94
formula above:

- average luminance matched within ~0.01%,
- per-pixel mean error ~0.04–0.06 (residual is only sphere-silhouette edge
  pixels and vertex-color interpolation across facets).

The harness also confirmed the details that matter for correctness:

- three r183 stores `directionalLights[i].direction` in **view space**,
  pointing **from the surface toward the light** (target→light), matching r94.
- r183's `getAmbientLightIrradiance` does **not** multiply by PI (r94's did),
  hence the `indirectDiffuse *= PI` compensation.
- r183 requires the injected code to declare its own loop variables: the
  upstream code referenced `directionalLight`/`directLight` after
  `lights_fragment_begin`, which only compiles under WebGL1/GLSL ES 1.0
  function scoping (r94). Under GLSL ES 3.0 (r183) those are block-scoped, so
  the loop was rewritten using `directionalLights[i]` and `directLight`
  (declared at top level) directly.

## 5. Files changed

| File | Change |
|------|--------|
| `src/engine/gfx/TextureUtils.ts` | removed `SRGBColorSpace` from palette textures (raw) |
| `src/engine/gfx/Renderer.ts` | `ColorManagement.enabled = false`; `outputColorSpace = LinearSRGBColorSpace` |
| `src/engine/gfx/material/paletteShaderLib.ts` | rewrote `paletteFullLightFragment` (PI compensation + `RE_Direct`-based extra light) |

## 6. Things not changed (and why)

- SHP/sprite rendering (`PaletteBasicMaterial`): unlit, identity before and
  after, so untouched.
- `paletteColorFrag` sampling coordinate: the port samples the palette with the
  raw 0..1 index instead of upstream's `(index*255+0.5)/256`. With
  `NearestFilter` this only differs at the extreme palette entries (index 0/255)
  and is cosmetically negligible; left as-is.
- Shadow receiving on VXL: upstream overwrites `directLight.color` with
  `extraIrradiance`, which also discards the shadow attenuation — the port
  reproduces that behavior (and VXL materials do not `receiveShadow` anyway).
