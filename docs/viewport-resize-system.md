# Viewport Resize System

This document explains how window/viewport resizing propagates through the application, why the menu screens rerender on resize, and the fixes applied for desktop resize flicker and mobile keyboard/typing issues.

## 1. The resize pipeline

The application renders to a fixed logical viewport that is CSS-scaled to fit the display. Every layout-affecting browser event flows through the following chain:

```
browser event (window resize, orientationchange, visualViewport resize)
  └─ Application.handleViewportEnvironmentChange        src/Application.ts
       └─ Application.updateViewportSize()              src/Application.ts
            └─ computeViewportLayout()  → new ViewportRect
            └─ viewport.value = nextViewport            BoxedVar fires onChange
                 └─ Gui.handleViewportChange            src/Gui.ts
                      ├─ renderer.setSize(...)           (immediate)
                      ├─ UiScene.setCamera / setViewport (immediate)
                      ├─ JsxRenderer.setCamera           (immediate)
                      ├─ scheduleRerenderCurrentScreen() (debounced 100 ms)
                      └─ canvasMetrics.notifyViewportChange()
                           └─ rootController.rerenderCurrentScreen()
                                └─ MainMenuRootScreen.onViewportChange  src/gui/screen/mainMenu/MainMenuRootScreen.ts
                                     ├─ mainMenu.setViewport(menuViewport)
                                     └─ mainMenuCtrl.rerenderCurrentScreen(true)
                                          └─ current screen: onLeave() + onEnter()   ← full DOM teardown + rebuild
```

`menuViewport` is a fixed **800×600** rect centered on the logical viewport (`UiScene.get menuViewport`, src/gui/UiScene.ts:79).

### Why a rerender is needed at all

Menu screens lay out their content in absolute coordinates against the current logical viewport **at enter time** (e.g. `LobbyScreen` pushes `{ viewport: this.uiScene.viewport }` into its JSX boxes; `MainMenu` anchors the status bar to `viewport.height`). In fit-window mode the logical viewport tracks the window size, so after a resize those positions are stale — the screen must be rebuilt. This behavior is inherited from upstream (`Gui.js` calls `rootController.rerenderCurrentScreen()` in its viewport handler).

## 2. Problems fixed (2026-08-16)

### 2.1 Spurious rerenders on every resize event

`BoxedVar.value` fires `onChange` on **reference inequality** (src/util/BoxedVar.ts:13), and `updateViewportSize` assigned a fresh object literal on every call — so even resize events that produced identical dimensions triggered a full screen rebuild.

**Fix:** `updateViewportSize` (src/Application.ts:482) compares width, height, scale, displayWidth/displayHeight, isMobileLayout and isPortrait against the current value and returns early when nothing changed.

### 2.2 Unthrottled rebuilds during a drag-resize

Each resize event during a window drag enqueued a full `onLeave() + onEnter()` (tens per second) — the rerender queue serialized but never coalesced them. That caused visible flicker and lag.

**Fix:** `Gui.scheduleRerenderCurrentScreen()` (src/Gui.ts) debounces the screen rerender by 100 ms. Renderer/camera updates stay immediate (no visual stretch); only the expensive screen rebuild waits for the resize to settle.

### 2.3 Sidebar button flicker on resize

`MainMenu.setViewport` previously destroyed and recreated **all** sidebar button objects (and replayed the slide-in animation) on every viewport change, even when the layout was unaffected.

**Fix:** `setViewport` (src/gui/screen/mainMenu/component/MainMenu.ts:77) now recomputes the slot count and bottom-clip height from the new viewport and only rebuilds when those actually change (`slotCount !== sidebarSlots.length || remainingHeight !== sidebarBottomClipHeight`). Pure repositioning (status bar, sidebar container) is done unconditionally and is cheap.

### 2.4 Mobile typing impossible (keyboard/viewport loop)

This repo added mobile handling that upstream never had:

- `window.visualViewport?.addEventListener('resize', ...)` (src/Application.ts) and `getAvailableDisplaySize()` reading `visualViewport` width/height — the visual viewport shrinks when the soft keyboard opens.
- `isNativeFullScreen()` — on mobile, `window.innerWidth >= screen.width` is essentially always true (CSS px ≈ screen px), so mobile is treated as fullscreen and the viewport is recomputed from the visual viewport.

The result was a loop that made text input impossible:

```
tap input → keyboard opens → visualViewport shrinks → viewport recompute
→ full screen rerender → input DOM destroyed → focus lost → keyboard closes
→ visualViewport grows → viewport recompute → rerender → (repeat forever)
```

**Fix:** `handleViewportEnvironmentChange` (src/Application.ts:142) now skips viewport recomputation while an editable element is focused (`isEditableElementFocused()`: `<input>`, `<textarea>`, or `contenteditable`). The viewport stays stable for the duration of typing, so no rerender, no focus loss. On blur, the viewport recomputes normally.

## 3. Divergence from upstream

| Aspect | Upstream (0.83.2) | This repo |
|---|---|---|
| Resize listener | `window.resize` only | `window.resize` + `orientationchange` + `visualViewport.resize` |
| Viewport source | `window.innerWidth/Height` | `visualViewport` when available |
| Mobile viewport | none (desktop-style) | `MOBILE_BASE_VIEWPORT` (800×600) + fullscreen stretch |
| Rerender on resize | immediate, on every change | debounced 100 ms + value-equality guard |
| Resize while typing | N/A (no visualViewport) | skipped entirely until blur |

## 4. Related code

- `src/Application.ts` — viewport computation, equality guard, editable-focus suppression
- `src/Gui.ts` — renderer/camera updates, debounced screen rerender
- `src/gui/UiScene.ts` — logical viewport, `menuViewport` (800×600), UI camera
- `src/gui/screen/mainMenu/MainMenuRootScreen.ts` — `onViewportChange` (setViewport + rerender current screen)
- `src/gui/screen/mainMenu/component/MainMenu.ts` — menu layout; sidebar button rebuild only on real layout change
- `src/util/BoxedVar.ts` — reference-based change notification (fires on every assignment of a new object)
