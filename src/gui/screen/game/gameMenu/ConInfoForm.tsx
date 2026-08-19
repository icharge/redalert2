import React, { useState, useEffect } from 'react';
import { CountryIcon } from '@/gui/component/CountryIcon';
import { OBS_COUNTRY_NAME } from '@/game/gameopts/constants';
import { RECIPIENT_ALL, RECIPIENT_TEAM } from '@/network/gservConfig';
import { PlayerConnectionStatus } from '@/network/gamestate/PlayerConnectionStatus';
import { Chat } from '@/gui/component/Chat';
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
}
interface ConInfo {
    name: string;
    status: any;
    ping?: number;
    lagAllowanceMillis?: number;
    timeoutAt?: number;
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
export const ConInfoForm: React.FC<ConInfoFormProps> = ({ strings, conInfos, players, localPlayer, messages, chatHistory, onSendMessage, }) => {
    const [timeRemaining, setTimeRemaining] = useState(() => Math.floor((TURN_TIMEOUT_MILLIS -
        LAG_STATE_THRESH_MILLIS -
        CON_INFO_THRESH_MILLIS) /
        1000));
    useEffect(() => {
        const interval = setInterval(() => setTimeRemaining(Math.max(0, timeRemaining - 1)), 1000);
        return () => clearInterval(interval);
    }, [timeRemaining]);
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
            </tr>
          </thead>
          <tbody>
            {players
            .filter((player) => !player.isAi)
            .map((player) => {
            const conInfo = conInfos?.find((info) => info.name === player.name);
            return (<tr key={player.name} style={{
                    color: player.color.asHexString(),
                    opacity: conInfo &&
                        conInfo.status !== PlayerConnectionStatus.Connected
                        ? 0.5
                        : 1,
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
                    <td className="player-time" title={conInfo?.timeoutAt ? strings.get("ts:reconnect_time_remaining") : undefined}>
                      {conInfo?.timeoutAt
                    // Player is mid-rejoin-grace-window: count down to the
                    // deadline the server reported (already frozen for the
                    // duration of any manual pause, see GservServer).
                    ? formatReconnectCountdown(conInfo.timeoutAt)
                    : conInfo
                        ? Math.floor((conInfo.lagAllowanceMillis ?? 0) / 1000)
                        : undefined}
                    </td>
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
