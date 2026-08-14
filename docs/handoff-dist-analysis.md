# Dist/Upstream JavaScript Analysis Handoff

Date: 2026-08-13

## Objective

Compare the downloaded upstream JavaScript runtime with the TypeScript codebase, determine whether the libraries in `package.json` need updating, and record feature-level differences for continuation in another session.

## Artifacts inspected

- `downloaded-game-js/manifest.json`
- `downloaded-game-js/dist/ra2web.min.js` — upstream RA2WEB `0.83.3`, 2,430,085 bytes
- `downloaded-game-js/dist/vendor.bundle.min.js`
- `downloaded-game-js/dist/spbots.min.js`
- `downloaded-game-js/dist/7zz.js`
- `downloaded-game-js/dist/ffmpeg.min.js`
- `downloaded-game-js/dist/web-audio-polyfill.min.js`
- `downloaded-game-js/lib/three.min.js` — Three.js `REVISION="94"`
- `downloaded-game-js/lib/three/three.shader-patch.js`
- `downloaded-game-js/lib/three/SPE.min.js` — `shader-particle-engine 1.0.6`
- `downloaded-game-js/lib/three/SPE.patch.js`
- `downloaded-game-js/lib/three/three.octree.js`
- `downloaded-game-js/lib/three/LightningStrike.js`
- `downloaded-game-js/lib/three/TrailRenderer.js`
- `downloaded-game-js/lib/three/SimplexNoise.js`
- `downloaded-game-js/lib/growingpacker.js`
- `downloaded-game-js/lib/lzo1x.js`
- `downloaded-game-js/lib/fullscreen-api-polyfill.min.js`
- `downloaded-game-js/lib/poll.js`
- `src/` and `package.json`/`bun.lock`

No source maps were present for the downloaded runtime. The analysis therefore used module-name extraction, minified-code inspection, library headers/version markers, and source-level comparison rather than exact source recovery.

## Dependency conclusion

Do **not** update or downgrade the application libraries based on these upstream files.

Current locked versions are intentional modern replacements:

- `three`: `0.183.2` — keep; upstream `r94` is legacy and incompatible with the modernized source without extensive changes.
- `@types/three`: `0.183.1` — matches the application Three.js generation.
- `shader-particle-engine`: `1.0.6` — same version as upstream `SPE.min.js`.
- `@brakebein/threeoctree`: `2.0.1` — modern replacement for upstream’s old global `three.octree.js`.
- `three.meshline`: `1.4.0` — used by the TypeScript trail implementation.
- `7z-wasm`: `1.1.0` — replaces the upstream `7zz.js` wrapper.
- `@ffmpeg/ffmpeg`: `0.12.15` — replaces the upstream FFmpeg wrapper.

Important dependency note: `shader-particle-engine` declares a nested legacy Three.js dependency (`three@0.84.0` in `bun.lock`). This is legacy package baggage, not a reason to change the root `three` version. If cleanup is desired later, prefer a compatibility wrapper/fork or dependency-resolution strategy instead of downgrading Three.js.

## Module-level comparison

`ra2web.min.js` contains 1,253 named `System.register` modules.

The TypeScript tree contains 1,356 source modules after path normalization. There are 1,247 exact upstream/local path matches and six upstream paths without standalone local equivalents:

- `game/api/interface/PlaceCheckOptions`
- `game/api/interface/ReachabilityMap`
- `gui/screen/mainMenu/ScreenParamsMap`
- `gui/screen/ScreenParamsMap`
- `network/WolConnectOptions`
- `util/retry`

The missing items are mostly type-only modules or functionality inlined into existing files. `WolConnectOptions` is represented in `src/network/WolService.ts`; retry logic is in `src/network/WGameResService.ts`. The API option types are not currently represented as standalone exported interfaces.

The local-only source tree includes approximately 108 unique paths, primarily:

- `src/network/lan/*` — LAN multiplayer and LAN lockstep.
- `src/game/ai/thirdpartbot/*` — third-party and built-in bot sandbox.
- `src/tools/*` and performance tests.
- Mobile touch controls, storage/file-system access, replay stats, and related fork tooling.
- Modernized replacements such as `src/setupThreeGlobal.ts`, `src/engine/renderable/fx/speCompat.ts`, and custom VFX.

## Features confirmed present in TypeScript

The upstream gameplay/network features are present in the current source, including:

- Engineer capture cast progress: `src/game/gameobject/trait/CastProgressTrait.ts`, `src/engine/renderable/entity/UnitCastBarSprite.ts`.
- Delayed oil capture: `src/game/gameobject/trait/SecureProgressTrait.ts`, `src/engine/renderable/entity/SecureProgressSprite.ts`.
- `SpecialWarheadType`: `src/game/SpecialWarheadType.ts` and updated `Warhead` call sites.
- Forced disguise/Bender of Spoons: `src/engine/renderable/entity/plugin/ForcedDisguisePlugin.ts`.
- `MoveNextToTask`: `src/game/gameobject/task/move/MoveNextToTask.ts`.
- Expanded game/player APIs: `src/game/api/GameApi.ts`, `src/game/api/PlayerApi.ts`.
- Worker processing: `src/worker/workerHost.ts`, `src/worker/workerApi.ts`.
- WOL and online services: `src/network/WolConnection.ts`, `src/network/WolService.ts`, `src/network/MapTransferService.ts`, `src/network/WGameResService.ts`.
- Deterministic lockstep: `src/network/gamestate/LockstepManager.ts`.

## Confirmed semantic gaps and risks

### 1. High priority: missing Three.js shader patch

Upstream `downloaded-game-js/lib/three/three.shader-patch.js` patches these shader chunks:

- `begin_vertex`
- `color_fragment`
- `color_pars_fragment`
- `color_vertex`
- `defaultnormal_vertex`
- `uv_pars_vertex`

The patch consumes custom attributes `instanceMatrix0..3`, `instanceColor`, and `instanceOpacity` under `INSTANCE_TRANSFORM`.

The TypeScript code still defines `INSTANCE_TRANSFORM` and custom instance attributes in `src/engine/gfx/batch/InstancedMesh.ts`, but no equivalent patch was found. `PaletteBasicMaterial`, `PaletteLambertMaterial`, and `PalettePhongMaterial` inject custom palette snippets but do not replace the modern Three.js `begin_vertex` transform logic.

Static analysis indicates that mesh instancing may not apply per-instance transforms, normals, opacity, or shadows correctly when enabled. This should be tested and fixed before relying on mesh instancing.

Recommended next step: port the required behavior to Three.js `0.183.2` shader chunks, or migrate the implementation to native `USE_INSTANCING`/modern `InstancedMesh` shader paths.

### 2. Medium priority: incomplete SPE patch

Upstream `downloaded-game-js/lib/three/SPE.patch.js` patches:

- `_assignRotationValue` to skip empty rotation configuration.
- `_assignColorValue` to preserve exact colors when spread is zero.
- `_assignAbsLifetimeValue` to preserve exact values when spread is zero.

The local `src/engine/renderable/fx/speCompat.ts` only patches the shader uniform name (`texture` to `particleTexture`) and legacy buffer compatibility. It does not port the three emitter behavior patches.

Recommended next step: reproduce the upstream emitter patches in a typed compatibility module and add focused tests for zero-spread color, opacity/size, and rotation initialization.

### 3. Medium priority: VFX implementation differences

Upstream uses:

- `THREE.LightningStrike` for Tesla/lightning effects.
- `THREE.TrailRenderer` for projectile trails.

The TypeScript implementation uses:

- `src/engine/renderable/fx/TeslaFx.ts` — manually rebuilt line geometry.
- `src/engine/renderable/fx/LineTrailFx.ts` — `three.meshline` implementation.

These are intentional replacements, not missing package dependencies, but they are not guaranteed visual/behavioral parity. Compare timing, orientation, fade, width, and camera behavior if exact upstream parity is required.

### 4. Lower priority: browser compatibility polyfills

The upstream runtime ships fullscreen and Web Audio polyfills. The TypeScript source uses native/browser-specific wrappers instead:

- `src/util/fullScreen.ts`
- `src/gui/FullScreen.ts`
- `src/engine/sound/AudioSystem.ts`

This is acceptable for the current browser target but may differ on older Safari/mobile browsers. No package update is indicated.

### 5. Existing compile error

The read-only verification command was:

```text
bun --bun tsc -p tsconfig.build.json --noEmit
```

It currently fails with:

```text
src/game/gameobject/task/move/MoveNextToTask.ts(37,33): error TS2552: Cannot find name 'unit'. Did you mean '_unit'?
```

`canStopAtTile` receives `_unit` but calls `super.canStopAtTile(unit, tile, onBridge)`. Fix this before using typecheck as a parity gate.

## Working-tree note

At analysis time, Git reported:

- Modified: `public/config.ini`
- Untracked: `downloaded-game-js/`

These were preserved. Do not reset or remove them without confirming ownership and intent.

## Recommended next-session sequence

1. Fix the `MoveNextToTask.ts` compile error.
2. Build a minimal browser/WebGL test for `MeshInstancingBatch` with translation, non-uniform scale, opacity, and shadow rendering.
3. Port or replace `three.shader-patch.js` behavior for Three.js `0.183.2`.
4. Add and test the three missing `SPE.patch.js` emitter behaviors.
5. Compare `TeslaFx` and `LineTrailFx` against upstream visual behavior.
6. Re-run:

```text
bun --bun tsc -p tsconfig.build.json --noEmit
bun test
```

7. Only after the above, decide whether any dependency changes are justified. Current evidence does not support changing `package.json` versions.

## Related documentation

`docs/upstream-0.83.2-parity.md` contains an older parity report based on upstream `0.83.2`. This handoff supersedes its module-count conclusions because the inspected downloaded bundle is `0.83.3`, and it adds the shader/SPE patch findings above.
