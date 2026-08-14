import React from "react";
import classnames from "classnames";
import { aiUiNames } from "@/game/gameopts/constants";
import { CountryIcon } from "@/gui/component/CountryIcon";
import { RankIndicator } from "@/gui/screen/mainMenu/lobby/component/RankIndicator";
import { WolGameReportResult } from "@/network/WolGameReport";
import { formatTimeDuration } from "@/util/format";
interface ScoreTableProps {
    game: any;
    singlePlayer: boolean;
    tournament: boolean;
    localPlayer: any;
    isQuit?: boolean;
    gameReport?: any;
    strings: any;
}
const PointGain: React.FC<{
    value: number;
    win: boolean;
    className?: string;
}> = ({ value, win, className }) => {
    let prefix: string;
    if (value > 0) {
        prefix = "+";
    }
    else if (value === 0) {
        prefix = win ? "+" : "-";
    }
    else {
        prefix = "";
    }
    return React.createElement("span", { className: classnames(className, { positive: win }) }, prefix, value);
};
export const ScoreTable: React.FC<ScoreTableProps> = ({ game, singlePlayer, tournament, localPlayer, isQuit, gameReport, strings, }) => {
    const players = game
        .getNonNeutralPlayers()
        .filter((player: any) => !player.isObserver || player.defeated)
        .sort((a: any, b: any) => b.score - a.score);
    const showReport = tournament && gameReport;
    const localPlayerReport = gameReport?.players.find((player: any) => player.name.toLowerCase() === localPlayer.name.toLowerCase());
    let resultType = localPlayerReport?.resultType;
    if (resultType === undefined) {
        if (game.stalemateDetectTrait?.isStale() &&
            game.stalemateDetectTrait.getCountdownTicks() === 0) {
            resultType = WolGameReportResult.Draw;
        }
        else if (localPlayer.defeated || isQuit) {
            if (!game.alliances
                .getAllies(localPlayer)
                .filter((ally: any) => !ally.isAi && !ally.defeated).length) {
                resultType = WolGameReportResult.Loss;
            }
        }
        else if (!localPlayer.isObserver) {
            resultType = WolGameReportResult.Win;
        }
    }
    return React.createElement("div", { className: "score-wrapper" }, (resultType || !singlePlayer) &&
        React.createElement("div", { className: "score-title" }, React.createElement("div", { className: "game-result" }, resultType === WolGameReportResult.Win
            ? strings.get("gui:gameresultvictory")
            : resultType === WolGameReportResult.Draw
                ? strings.get("gui:gameresultdraw")
                : resultType === WolGameReportResult.Loss
                    ? strings.get("gui:gameresultdefeat")
                    : ""), !gameReport &&
            !singlePlayer &&
            (tournament || resultType === undefined) &&
            React.createElement("div", { className: "pending-results" }, strings.get("gui:gameresultwaiting")), localPlayerReport?.points &&
            React.createElement("div", { className: "points-gain" }, strings.get("GUI:LadderPoints"), " ", localPlayerReport.points.value, " (", React.createElement(PointGain, {
                className: "points-gain-value",
                value: localPlayerReport.points.gain,
                win: resultType === WolGameReportResult.Win,
            }), ")")),
        React.createElement("div", { className: "score-header" },
            React.createElement("div", { "data-r-tooltip": strings.get("STT:MPScoreLabelMapName") }, strings.get("TXT_MAP", game.gameOpts?.mapTitle ?? "")),
            React.createElement("div", { "data-r-tooltip": strings.get("STT:MPScoreLabelTime") }, strings.get("GUI:Time"), ": ", formatTimeDuration(Math.floor(game.currentTime / 1000)))),
        React.createElement("table", null, React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", null), React.createElement("th", { className: "player-rank" }), React.createElement("th", { className: "player-name", "data-r-tooltip": strings.get("STT:MPScoreLabelPlayer") }, strings.get("GUI:Player")), showReport && React.createElement("th", { className: "number" }, strings.get("GUI:MMR")), React.createElement("th", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelKills") }, strings.get("GUI:Kills")), React.createElement("th", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelLosses") }, strings.get("GUI:Losses")), React.createElement("th", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelBuilt") }, strings.get("GUI:Built")), React.createElement("th", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelScore") }, strings.get("GUI:Score")))), React.createElement("tbody", null, players.map((player: any, index: number) => {
        const playerReport = gameReport?.players.find((p: any) => p.name.toLowerCase() === player.name.toLowerCase());
        const mmrValue = playerReport?.mmr?.value;
        const mmrGain = playerReport?.mmr?.gain;
        return React.createElement("tr", {
            key: index,
            style: { color: player.color.asHexString() },
        }, React.createElement("td", null, React.createElement(CountryIcon, { country: player.country.name })), React.createElement("td", { className: "player-rank" }, playerReport &&
            React.createElement(RankIndicator, {
                playerProfile: playerReport,
                strings: strings,
            })), React.createElement("td", { className: "player-name", "data-r-tooltip": strings.get("STT:MPScoreLabelPlayer") }, player.isAi
            ? strings.get(aiUiNames.get(player.aiDifficulty))
            : player.name), showReport &&
            React.createElement("td", { className: "number player-mmr" }, mmrValue ?? "-", mmrGain !== undefined &&
                React.createElement(React.Fragment, null, " (", React.createElement(PointGain, {
                    className: "mmr-gain",
                    value: mmrGain,
                    win: playerReport?.resultType === WolGameReportResult.Win,
                }), ")")), React.createElement("td", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelKills") }, player.getUnitsKilled()), React.createElement("td", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelLosses") }, player.getUnitsLost()), React.createElement("td", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelBuilt") }, player.getUnitsBuilt()), React.createElement("td", { className: "number", "data-r-tooltip": strings.get("STT:MPScoreLabelScore") }, player.score));
    }))));
};
