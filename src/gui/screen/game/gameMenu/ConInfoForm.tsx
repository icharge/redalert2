import React, { useState, useEffect } from 'react';
import { CountryIcon } from '@/gui/component/CountryIcon';
import { OBS_COUNTRY_NAME } from '@/game/gameopts/constants';
import { RECIPIENT_ALL, RECIPIENT_TEAM } from '@/network/gservConfig';
import { PlayerConnectionStatus } from '@/network/gamestate/PlayerConnectionStatus';
import { Chat } from '@/gui/component/Chat';
import { VoteChoice, VoteTally } from '@/network/GservConnection';
interface Color {
    asHexString(): string;
}
interface Country {
    name: string;
}
interface Player {
    name: string;
    color: Color;
    country?: Country;
    isAi: boolean;
    isObserver?: boolean;
}
interface ConInfo {
    name: string;
    status: any;
    ping?: number;
    lagAllowanceMillis?: number;
    timeoutAt?: number;
    // Replay catch-up percentage, only meaningful while status is Rejoining.
    loadPercent?: number;
}
interface Strings {
    get(key: string, ...args: any[]): string;
}
interface ChatHistory {
    lastComposeTarget?: {
        value: {
            type: any;
            name: string;
        };
    };
}
interface ConInfoFormProps {
    strings: Strings;
    conInfos?: ConInfo[];
    players: Player[];
    localPlayer: Player;
    messages: any[];
    chatHistory?: ChatHistory;
    onSendMessage: (message: string) => void;
    // Keyed by the departed player each open kick/wait vote is about. Absent
    // or empty for games too small to vote -- the column renders nothing.
    voteTallies?: Map<string, VoteTally>;
    onVote?: (targetNick: string, choice: VoteChoice) => void;
}
const TURN_TIMEOUT_MILLIS = 60000;
const LAG_STATE_THRESH_MILLIS = 5000;
const CON_INFO_THRESH_MILLIS = 3000;
// Above this, treat the deadline as "hold indefinitely" (GservServer's
// ABANDONED_HOLD_INDEFINITELY_DEADLINE sentinel) rather than rendering a
// meaningless multi-million-second countdown.
const INDEFINITE_THRESHOLD_MILLIS = 365 * 24 * 60 * 60 * 1000;
function formatReconnectCountdown(timeoutAt: number): React.ReactNode {
    const remainingMillis = timeoutAt - Date.now();
    if (remainingMillis > INDEFINITE_THRESHOLD_MILLIS) {
        return "∞";
    }
    return Math.max(0, Math.ceil(remainingMillis / 1000));
}
export const ConInfoForm: React.FC<ConInfoFormProps> = ({ strings, conInfos, players, localPlayer, messages, chatHistory, onSendMessage, voteTallies, onVote, }) => {
    const [timeRemaining, setTimeRemaining] = useState(() => Math.floor((TURN_TIMEOUT_MILLIS -
        LAG_STATE_THRESH_MILLIS -
        CON_INFO_THRESH_MILLIS) /
        1000));
    useEffect(() => {
        const interval = setInterval(() => setTimeRemaining(Math.max(0, timeRemaining - 1)), 1000);
        return () => clearInterval(interval);
    }, [timeRemaining]);
    // Games too small to vote (2 players) never get a vote session at all, and
    // a resolved/closed session's tally is removed rather than kept empty --
    // so this is a reliable "is voting relevant right now" signal. Gating the
    // whole column on it avoids showing a permanently empty "Vote" column in
    // every 2-player game.
    const hasOpenVote = !!voteTallies && voteTallies.size > 0;
    return (<div className="con-info-form">
      <div className="con-info-form-content">
        <table>
          <thead>
            <tr>
              <th></th>
              <th className="player-name">
                {strings.get("GUI:Player")}
              </th>
              <th className="player-ping">
                {strings.get("GUI:Ping")}
              </th>
              <th className="player-time">
                {strings.get("GUI:Time")}
              </th>
              {hasOpenVote && (<th className="player-vote">
                {strings.get("gui:vote_column")}
              </th>)}
            </tr>
          </thead>
          <tbody>
            {players
            .filter((player) => !player.isAi)
            .map((player) => {
            const conInfo = conInfos?.find((info) => info.name === player.name);
            // The dimming lives on a class rather than an inline row opacity so
            // the stylesheet can exempt the vote cell: opacity on the <tr>
            // creates a stacking context its children cannot climb back out of,
            // which would leave this screen's only interactive control greyed
            // out on exactly the row it belongs to (the departed player's).
            const absent = !!conInfo && conInfo.status !== PlayerConnectionStatus.Connected;
            return (<tr key={player.name} className={absent ? "player-row player-row-absent" : "player-row"} style={{
                    color: player.color.asHexString(),
                }}>
                    <td>
                      <div className="player-icon-wrap">
                        <CountryIcon country={player.country
                    ? player.country.name
                    : OBS_COUNTRY_NAME}/>
                        {conInfo && conInfo.status !== PlayerConnectionStatus.Connected && (conInfo.timeoutAt
                    // Still within the rejoin grace window: distinct from a
                    // permanent departure, since this player may still come
                    // back (the player-time column shows the countdown).
                    ? (<span className="player-reconnecting-badge" title={strings.get("ts:player_reconnecting", player.name)}>
                            ⟳
                          </span>)
                    : (<span className="player-disconnect-badge" title={strings.get("ts:player_left", player.name)}>
                            ✕
                          </span>))}
                      </div>
                    </td>
                    <td className="player-name">
                      {player.name}
                    </td>
                    <td className="player-ping">
                      <meter value={conInfo?.ping ?? 1000} max={1000} low={150} high={500} optimum={0}/>
                    </td>
                    <td className="player-time" title={conInfo?.status === PlayerConnectionStatus.Rejoining
                    ? strings.get("ts:rejoin_progress")
                    : conInfo?.timeoutAt
                        ? strings.get("ts:reconnect_time_remaining")
                        : undefined}>
                      {conInfo?.status === PlayerConnectionStatus.Rejoining
                    // Reconnected and replaying the match from turn 0 to catch
                    // up. Show how far along they are rather than a reconnect
                    // countdown -- they are already back, the wait now depends
                    // on replay speed, not on whether they return at all.
                    ? (<progress className="player-rejoin-progress" value={conInfo.loadPercent ?? 0} max={100}>
                            {conInfo.loadPercent ?? 0}%
                          </progress>)
                    : conInfo?.timeoutAt
                        // Player is mid-rejoin-grace-window: count down to the
                        // deadline the server reported (already frozen for the
                        // duration of any manual pause, see GservServer).
                        ? formatReconnectCountdown(conInfo.timeoutAt)
                        : conInfo
                            ? Math.floor((conInfo.lagAllowanceMillis ?? 0) / 1000)
                            : undefined}
                    </td>
                    {hasOpenVote && (<td className="player-vote">
                      {(() => {
                    const tally = voteTallies?.get(player.name);
                    // No open session for this row (2-player game, this player
                    // isn't the one who dropped, or the vote already resolved):
                    // nothing to render. Also never on the local player's own
                    // row -- the server closes their session the moment they
                    // reconnect, before this screen could show it to them. And
                    // never for an observer viewer: the server silently no-ops
                    // a vote cast by a non-required player (isEligibleVoter),
                    // so showing clickable buttons here would just be buttons
                    // that quietly do nothing.
                    if (!tally || player.name === localPlayer.name || !onVote || localPlayer.isObserver) {
                        return null;
                    }
                    const myChoice = tally.votesByNick.get(localPlayer.name);
                    const tallyDetail = strings.get("ts:vote_tally_detail", tally.kickVotes, tally.majorityThreshold, tally.waitVotes, tally.extensionsRemaining);
                    // Already voted: a cast vote is final (GservServer's
                    // handleVote refuses a second one from the same nick), so
                    // show the standing count rather than controls that would
                    // silently do nothing.
                    if (myChoice) {
                        return (<div className="vote-controls vote-controls-cast" title={strings.get("ts:vote_already_cast") + " " + tallyDetail}>
                            <span className={"vote-cast vote-cast-" + myChoice}>
                              {strings.get(myChoice === "kick" ? "gui:vote_kick" : "gui:vote_wait")}
                            </span>
                            <span className="vote-tally">
                              {tally.kickVotes}/{tally.majorityThreshold}
                            </span>
                          </div>);
                    }
                    const waitIsAdvisoryOnly = tally.extensionsRemaining === 0;
                    return (<div className="vote-controls">
                            <button type="button" className="vote-choice" title={tallyDetail} onClick={() => onVote(player.name, "kick")}>
                              {strings.get("gui:vote_kick")}
                            </button>
                            <button type="button" className="vote-choice" disabled={waitIsAdvisoryOnly} title={waitIsAdvisoryOnly ? strings.get("ts:vote_extensions_exhausted") : tallyDetail} onClick={() => onVote(player.name, "wait")}>
                              {strings.get("gui:vote_wait")}
                            </button>
                          </div>);
                })()}
                    </td>)}
                  </tr>);
        })}
          </tbody>
        </table>
      </div>
      <div className="con-info-form-footer">
        <div className="time-allowed">
          {strings.get("TXT_TIME_ALLOWED", timeRemaining)}
        </div>
        <div className="chat">
          <Chat strings={strings} messages={messages} channels={[RECIPIENT_ALL, RECIPIENT_TEAM] as any} chatHistory={chatHistory} userColors={new Map(players.map((player) => [player.name, player.color.asHexString()]))} localUsername={localPlayer.name} onSendMessage={onSendMessage as any} onCancelMessage={undefined as any}/>
        </div>
      </div>
    </div>);
};
