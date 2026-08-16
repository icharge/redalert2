# Quick Match chat on the queue channel (no lobby players)

**Goal**: the Quick Match screen's chat + players list should only show players queuing for the same mode, not the whole lobby. Chat joins the queue channel (`#Lob 50 0` = 1v1, `#Lob 51 0` = 2v2; Yuri 60/61) instead of the lobby channel (`#Lob 45 0`). This is a deliberate deviation from upstream parity (which chats on the lobby) — chosen by the user.

## Current state (verified)

- `ChatUi.loadChannel` joins `#Lob <clientChannelType> 0` (= `#Lob 45 0`, the lobby) — shows every online lobby player in the QM chat list (`QuickGameChat.tsx` renders `players-list` of the channel)
- `ChatUi.onChannelJoinLeave` early-returns for **all** quick-match channels (50/51) — would break user-list updates if the chat channel is a QM channel
- Client `WolConnection.handleJoin` dispatches `onJoinChannel` for every JOIN line, including the server's duplicate-join reply (already committed) — ChatUi would push a duplicate self entry without a dedupe guard
- `joinQueue` joins the queue channel again (upstream behavior) — safe now thanks to the server's duplicate-join reply
- ChatUi is used only by QuickGameScreen (no other consumers)

## Changes

### 1. `src/gui/screen/mainMenu/quickGame/ChatUi.ts`

- `loadChannel(queueType: LadderQueueType, cancellationToken)` — channel becomes `#Lob ${this.wolConfig.getQuickMatchChannelId(queueType)} 0`
  - Idempotent: if the requested channel is already `this.channelName`, return immediately
  - If switching channels: leave the old channel, clear `users`, join the new one; on cancellation, leave the new one (same pattern as today)
- Subscription idempotency: subscribe the 4 handlers once (guard with a `subscribed` flag) so repeated `loadChannel` calls (type switches) don't stack subscriptions
- `onChannelJoinLeave` rework:
  - Skip events only for **other** quick-match channels (`event.channel` is a QM channel AND `!== this.channelName`) — the current blanket QM skip is removed
  - User-list updates keep the existing `event.channel === this.channelName` guard
  - **Dedupe** the user list on join (`if (!this.users.some(u => u.name === event.user.name))`) so the duplicate-join reply doesn't duplicate the local player
  - No self join/leave system message for the QM chat channel (the lobby `TXT_LOB_*` label would be wrong for it; queue state UI already communicates status)
- `dispose()` unchanged (leaves channel + unsubscribes — already upstream parity)

### 2. `src/gui/screen/mainMenu/quickGame/QuickGameScreen.ts`

- New field `private chatChannelCancellation?: CancellationTokenSource` and helper `switchQuickMatchChat()` — cancels the previous source, creates a fresh one, calls `chatUi.loadChannel(this.queueOpts.type, token)` (errors logged, non-fatal)
- `onEnter`: call `chatUi.loadChannel(this.queueOpts.type, channelJoinCancellation.token)` (same try/catch error mapping as today); keep the `messages.push({text})` failure path
- Switch the chat channel wherever `queueOpts.type` changes:
  - `onTypeChange` (form select) — after the existing type/playerProfile/prefs updates
  - `handlePartyUpdate` — when the party forces `LadderQueueType.Team2v2`
  - `restorePrePartyQueueType` — when the party dissolves and the type is restored
- `onLeave`: cancel `chatChannelCancellation` alongside the existing cleanup

### 3. Server — no changes

The duplicate-join reply (committed) already makes `joinQueue`'s second join of the same channel safe; queue channels auto-create on first join. `getUserQueueType` on the server already resolves the queue type from the channel the client is in, so the chat join itself satisfies the matchbot's channel requirement.

## Edge cases

- **Rapid type switches** (1v1 ↔ 2v2): each switch cancels the previous `loadChannel`; a cancelled join leaves the half-joined channel. Brief channel mismatch possible during the race — acceptable, converges to the last selection.
- **Party flow**: party forces 2v2 (chat → `#Lob 51 0`); dissolving restores the previous type (chat → back). Party members can still whisper/invite each other from the queue-channel list.
- **Double join**: `joinQueue`'s join while already chatting in the channel → server replies → client dedupes the user list.
- **QM channel system messages**: no "You joined #Lob 50 0" noise; only the players list updates.

## Verification

- `bun --bun tsc -p tsconfig.build.json --noEmit` — clean
- `bun test src/test` — existing client suites green (server suite untouched)
- Manual smoke: two clients in QM — players list shows only queuers; switching 1v1/2v2 swaps the list; party invite from the QM list works; queue → match still starts.

## Out of scope

- Party system improvements (already exists server-side; invites from the QM list now reach only queuers — recent-players invite button unchanged)
- Any server-side matchmaking changes
