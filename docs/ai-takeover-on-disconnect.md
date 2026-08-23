# AI Takeover on Disconnect

Status: **research only** — feasibility explored, nothing implemented. Out of scope for the
current reconnection-improvements iteration (see
[`reconnection-improvements.md`](reconnection-improvements.md)).

Audience: engineers considering whether to let an AI pilot a disconnected player's army.

## 1. The idea

When a human player drops mid-game, today the match pauses and everyone waits out a grace
window; if it expires the player is resigned and their assets are destroyed. An alternative
—modelled on Dota 2's bot takeover — is to let the existing skirmish AI **take a seat** and
play that army until the human reconnects (or permanently, if they never do), so the match
keeps moving instead of stalling.

The hard constraint is **deterministic lockstep**: every client must independently compute
bit-identical simulation state from the same input stream. Any AI driving a player's army has
to be deterministic and flow through the same turn-based action pipeline as human input — it
cannot be ad-hoc logic running on one machine.

## 2. Verdict

**Moderate complexity — plug into existing AI, not a new subsystem.**

The hard architectural problem this feature poses is *already solved*. What's missing is
lifecycle wiring: the AI was built to be attached at game start and never detached.

## 3. What already works in our favour

**A real skirmish AI subsystem exists.**
- `src/game/BotManager.ts` — per-`Game` orchestrator, created in `src/game/GameFactory.ts:93-94`
  and wired into `Game` (`src/game/Game.ts:82,94,112`).
- `src/game/bot/BotFactory.ts` — dispatches on `AiDifficulty` to `BuiltInBotAdapter`
  (a large hand-written strategy AI under `src/game/ai/thirdpartbot/builtIn/bot/**`),
  `DummyBot` (`src/game/bot/DummyBot.ts`), or `ThirdPartyBotAdapter` (sandboxed user scripts).

**Bots already issue orders through the same pipeline humans do.** `BotManager.init()`
(`BotManager.ts:35-89`) builds an `ActionsApi`/`PlayerApi`/`ProductionApi` per bot exactly the
way `GameScreen.ts:1082` does for the local human. Both create real `Action` subclasses
(`src/game/action/*.ts`) and push them onto an `ActionQueue`. Bots are not special-cased.

**AI decisions are already deterministic and lockstep-safe.**
- `Game.update()` (`src/game/Game.ts:789-793`) calls `botManager.update()` unconditionally every
  tick — there is no "if I'm host" guard anywhere in `BotManager.ts` or `Game.ts`.
- `BotManager.update()` (`BotManager.ts:90-101`) applies bot actions **locally** and never
  touches the network layer. Every client independently computes identical bot moves.
- Randomness routes through the shared seeded PRNG: `GameApi` is constructed with
  `useGameRandom = true` (`BotManager.ts:36`), delegating to `Game.generateRandom()`
  (`Game.ts:936-941`), which is part of `Game.getHash()` (`Game.ts:942-951`). A grep of the
  built-in bot tree found no `Math.random()` / `Date.now()` usage.
- Confirming the model: `isAi` / `aiDifficulty` appear **nowhere** under `server/src/**`. The
  relay has no concept of AI slots; AI players never submit turn blobs and never appear in
  `requiredNicks`.

**Ownership is already trivially reassignable.** `isAi` is a plain mutable field on `Player`
(`src/game/Player.ts:21`), and `GameObject.owner` references that same `Player` instance — so
flipping it mid-game requires **zero** ownership reassignment. If reassignment is ever needed,
`Game.changeObjectOwner()` (`Game.ts:759-776`) is a proven primitive already used for civilian
building handback and ally asset redistribution on resign.

**The server already has the right plumbing shape.** `expireDeparted()`
(`GservServer.ts:882-924`) injects a synthetic per-player action blob (`RESIGN_ACTION_BLOB`,
`GservServer.ts:56-61`) into a departed player's turn slot and drops them from `requiredNicks`
so the relay stops waiting. A takeover action would reuse exactly this mechanism, wired to a
non-destructive action instead of resign.

## 4. The four real gaps

**1. `BotManager` provisions bots at init only.**
`init()` (`BotManager.ts:35-49`) snapshots `getCombatants().filter(c => c.isAi)` once. `update()`
does re-filter every tick (line 102) — but then calls `this.bots.get(combatant)` (line 103),
which returns `undefined` for a player that became AI later, so the loop just `continue`s
(lines 104-106). **A live `isAi` flip today produces no bot behaviour whatsoever.**

The fix is modest and self-contained: factor the per-bot setup block (`BotManager.ts:63-87`)
into something callable on demand. `BotFactory.create()` already accepts an arbitrary
`{isAi, name, aiDifficulty, country, customBotId}`-shaped player — precisely what `Player`
already carries (`Player.ts:39-40`). Nothing in `Bot` (`src/game/bot/Bot.ts`),
`BuiltInBotAdapter`, or `DummyBot` assumes construction at tick 0; `onGameStart(gameApi)` is
just a lifecycle hook (`BotManager.ts:82`).

**2. `ResignGameAction` has no non-destructive branch.**
`redistributeAllPlayerAssets()` (`Game.ts:913-935`) only hands assets to a top-scoring *human*
ally, and only under must-ally rulesets (`Game.ts:917`); it explicitly filters out AI players
(`Game.ts:920`). `removeAllPlayerAssets()` (`Game.ts:891-911`) returns a few structure types to
Civilian and **destroys everything else** (`Game.ts:898,908`). A takeover path must skip both —
new game logic plus a new `ActionType`.

**3. The server has zero `isAi` awareness.**
A takeover needs a genuinely new instance state — "AI-controlled, still reclaimable" — distinct
from today's binary paused-waiting vs. resigned-and-gone (`GservServer.ts:77-125`, `802-924`),
plus a reverse transition when the human reconnects. No precedent exists beyond the one-way
rejoin-after-pause flow.

**4. Custom/uploaded bots are not guaranteed deterministic.**
`BotSandbox.loadBotFromSource` (`src/game/ai/thirdpartbot/BotSandbox.ts:269-365`) executes
uploaded code via `new Function` with `restrictedGlobals` that include **unrestricted `Math` and
`Date`** (`BotSandbox.ts:284-309`, lines 291-292). `FORBIDDEN_PATTERNS` (lines 27-47) blocks
`eval` / `fetch` / `require` / `localStorage` but **not** `Math.random` / `Date.now`. A careless
or malicious uploaded bot would desync the match.

This matters more here than for today's opt-in skirmish use: a human choosing to face a custom
bot is one thing; auto-promoting one into a live synced match is a much bigger blast radius.
**Restricting takeover to the built-in AI and `DummyBot` sidesteps this entirely.** Supporting
custom bots would require hardening the sandbox first (route randomness/time through `gameApi`,
strip or replace `Math`/`Date` in the sandbox globals).

## 5. One untested unknown

The built-in AI's mission/economy logic (`src/game/ai/thirdpartbot/builtIn/bot/logic/mission/**`)
has almost certainly only ever run starting from a fresh base at tick 0. Handing it a half-built,
possibly-damaged, human-planned base mid-match is structurally fine — the bot builds its state
from live `gameApi` queries at `onGameStart` and the first few ticks, not from an assumed pristine
starting position — but behaviourally unproven. It could re-trigger expansion or base-building
missions inappropriately. This needs testing and tuning, not architecture work.

## 6. Interaction with full-replay rejoin

Because bot actions are computed locally per-client and **never recorded in the network
`turnLog`**, a rejoining client replaying a stretch of match where their own player was
AI-controlled would re-simulate the bot's decisions locally, tick by tick. That is coherent with
how full-replay rejoin already works (`Game.update()` → `botManager.update()` runs during replay
ticks exactly as during live ticks).

But it depends entirely on the bot being deterministic — and unlike a live desync, a divergence
inside a replayed segment would not be caught by the per-turn hash check in the same obvious way.
This makes gap #4 above materially more important for takeover than it is for skirmish play.

## 7. Summary of work required

| Area | Change | Size |
|---|---|---|
| `BotManager.ts` | Make bot provisioning dynamic instead of init-only | Small, self-contained |
| `Game.ts` / new `ActionType` | Non-destructive "hand off intact" path (skip both resign asset functions) | Medium |
| `GservServer.ts` | New reclaimable-AI instance state + synthetic takeover action + handback transition | Medium |
| `BotSandbox.ts` | Harden `Math`/`Date` — **only if** custom bots are in scope | Medium (avoidable) |
| Built-in AI tuning | Validate mid-match cold start on an inherited base | Unknown, likely tuning only |

Nothing in the current reconnection-improvements plan assumes or blocks this feature.
