import React, { useRef, useState, useEffect } from "react";
import classNames from "classnames";
import { RankIndicator } from "@/gui/screen/mainMenu/lobby/component/RankIndicator";
import { Select } from "@/gui/component/Select";
import { Option } from "@/gui/component/Option";
import { List, ListItem } from "@/gui/component/List";
import { WLadderService } from "@/network/ladder/WLadderService";
import { LadderType } from "@/network/ladder/wladderConfig";

const LADDER_TYPE_LABELS = new Map<LadderType, string>([
    [LadderType.Solo1v1, "gui:laddertype1v1"],
    [LadderType.Random2v2, "gui:laddertype2v2random"],
]);

interface PlayerLadderEntry {
    name: string;
    rank: number;
    points?: number;
    mmr?: number;
    wins: number;
    losses: number;
    draws?: number;
    rankType: any;
}

interface LadderProps {
    players?: PlayerLadderEntry[];
    highlightPlayer?: string;
    hasPrevPage: boolean;
    hasNextPage: boolean;
    seasons?: string[];
    selectedSeason?: string;
    seasonDetails?: any;
    ladders?: any[];
    selectedLadder?: any;
    serverRegion?: any;
    disabled: boolean;
    strings: any;
    onFirstPageClick: () => void;
    onPrevPageClick: () => void;
    onNextPageClick: () => void;
    onLastPageClick: () => void;
    onPlayerSearch: (playerName: string) => void;
    onSeasonSelect: (season: string) => void;
    onLadderSelect: (ladder: any) => void;
    onLadderTypeSelect: (ladderType: LadderType) => void;
}

function formatSeasonName(season: string, strings: any): string {
    return season === WLadderService.CURRENT_SEASON
        ? strings.get("GUI:LadderCurrent")
        : season === WLadderService.PREV_SEASON
            ? strings.get("GUI:LadderPrev")
            : strings.get("GUI:LadderSeason", season);
}

function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function formatTime(dateString: string): string {
    return new Date(dateString).toLocaleTimeString(undefined, { timeStyle: "short" });
}

const LadderTable: React.FC<{
    players: PlayerLadderEntry[];
    highlightPlayer?: string;
    ladderType?: LadderType;
    region?: any;
    season?: string;
    showPoints: boolean;
    showMmr: boolean;
    strings: any;
    hasPrevPage: boolean;
    hasNextPage: boolean;
    disabled: boolean;
    onFirstPageClick: () => void;
    onPrevPageClick: () => void;
    onNextPageClick: () => void;
    onLastPageClick: () => void;
}> = ({ players, highlightPlayer, ladderType, region, season, showPoints, showMmr, strings, hasPrevPage, hasNextPage, disabled, onFirstPageClick, onPrevPageClick, onNextPageClick, onLastPageClick }) => (
    <div className="ladder-table">
        <table>
            <thead>
                <tr>
                    <th className="player-rank">#</th>
                    <th className="player-rank-icon">{strings.get("GUI:Rank")}</th>
                    <th className="player-name">{strings.get("GUI:Name")}</th>
                    {showPoints && <th className="player-points">{strings.get("GUI:Points")}</th>}
                    {showMmr && <th className="player-mmr">{strings.get("GUI:MMR")}</th>}
                    <th className="player-wins">{strings.get("GUI:NumberWins")}</th>
                    <th className="player-losses">{strings.get("GUI:NumberLosses")}</th>
                </tr>
            </thead>
            <tbody>
                {players.map(player => (
                    <tr key={player.name} className={classNames({
                        selected: highlightPlayer?.toLowerCase() === player.name.toLowerCase(),
                        disabled: player.points === undefined && !player.wins && !player.losses && !player.draws,
                    })}>
                        <td className="player-rank">{player.rank}</td>
                        <td className="player-rank-icon">
                            <RankIndicator playerProfile={player} strings={strings}/>
                        </td>
                        <td className="player-name">
                            {(() => {
                                const leaderboardUrl = region && ladderType && season === WLadderService.CURRENT_SEASON
                                    ? region.leaderboardUrl
                                        ? `${region.leaderboardUrl}/player/${region.id}/${ladderType}/` + player.name
                                        : undefined
                                    : undefined;
                                return leaderboardUrl
                                    ? <a href={leaderboardUrl} target="_blank" rel="noopener">{player.name}</a>
                                    : player.name;
                            })()}
                        </td>
                        {showPoints && <td className="player-points">{player.points}</td>}
                        {showMmr && <td className="player-mmr">{player.mmr}</td>}
                        <td className="player-wins">{player.wins}</td>
                        <td className="player-losses">{player.losses ?? 0}</td>
                    </tr>
                ))}
            </tbody>
        </table>
        {(hasPrevPage || hasNextPage) && (
            <div className="pagination">
                <button className="first-page" disabled={!hasPrevPage || disabled} onClick={onFirstPageClick}>&lt;&lt;</button>
                <button className="prev-page" disabled={!hasPrevPage || disabled} onClick={onPrevPageClick}>&lt;</button>
                <button className="next-page" disabled={!hasNextPage || disabled} onClick={onNextPageClick}>&gt;</button>
                <button className="last-page" disabled={!hasNextPage || disabled} onClick={onLastPageClick}>&gt;&gt;</button>
            </div>
        )}
    </div>
);

export const Ladder: React.FC<LadderProps> = ({ players, highlightPlayer, hasPrevPage, hasNextPage, seasons, selectedSeason, seasonDetails, ladders, selectedLadder, serverRegion, disabled, strings, onFirstPageClick, onPrevPageClick, onNextPageClick, onLastPageClick, onPlayerSearch, onSeasonSelect, onLadderSelect, onLadderTypeSelect }) => {
    if (!players) {
        return <div className="ladder">{strings.get("GUI:LoadingEx")}</div>;
    }
    const searchBox = useRef<HTMLInputElement>(null);
    const [showSeasonInfo, setShowSeasonInfo] = useState(!selectedLadder);
    useEffect(() => {
        setShowSeasonInfo(!selectedLadder);
    }, [selectedLadder]);
    const getLadderKey = (ladder: any) => ladder.type + "_" + ladder.id;
    const hasMmr = players.some(player => player.mmr !== undefined);
    const hasPoints = players.some(player => player.points !== undefined);
    const selectedLadderType = selectedLadder?.type;
    const ladderTypes = [...new Set(seasonDetails?.ladders.map((ladder: any) => ladder.type) ?? (selectedLadderType ? [selectedLadderType] : undefined))] as LadderType[];
    const rankedPlayerCount = seasonDetails?.totalRankedPlayers.find((entry: any) => entry.ladderType === selectedLadderType)?.value;
    return (
        <div className="ladder">
            <div className={classNames("toolbar", { "no-season-select": !seasons || seasons.length < 2 })}>
                {seasons !== undefined && seasons.length > 0 && (
                    <Select disabled={disabled} initialValue={selectedSeason ?? seasons[0]} onSelect={onSeasonSelect} className="season-select">
                        {seasons.map(season => (
                            <Option key={season} label={formatSeasonName(season, strings)} value={season}/>
                        ))}
                    </Select>
                )}
                {!showSeasonInfo && (
                    <>
                        {ladders !== undefined && ladders.length > 0 && (
                            <Select disabled={disabled} initialValue={getLadderKey(selectedLadder ?? ladders[0])} onSelect={(value: string) => {
                                const { type, id } = (() => {
                                    const [type, id] = value.split("_");
                                    return { type, id: Number(id) };
                                })();
                                const ladder = ladders?.find((entry: any) => entry.id === id && entry.type === type);
                                if (ladder) {
                                    onLadderSelect(ladder);
                                }
                            }} className="ladder-select">
                                {ladders.map(ladder => (
                                    <Option key={ladder.type + "_" + ladder.id} label={ladder.name + (ladder.divisionName ? ", " + strings.get("GUI:LadderDivision", ladder.divisionName) : "")} value={getLadderKey(ladder)}/>
                                ))}
                                {rankedPlayerCount ? (
                                    <Option label={strings.get("GUI:LadderRankedPlayers", rankedPlayerCount)} disabled value=""/>
                                ) : undefined}
                            </Select>
                        )}
                        <form className="player-search" onSubmit={(event) => {
                            event.preventDefault();
                            if (searchBox.current?.value) {
                                onPlayerSearch(searchBox.current.value);
                                searchBox.current.value = "";
                            }
                        }}>
                            <input className="player" type="text" disabled={disabled} ref={searchBox} placeholder={strings.get("GUI:Player")}/>
                            <button type="submit" disabled={disabled}>{strings.get("GUI:Search")}</button>
                        </form>
                    </>
                )}
            </div>
            <div className="ladder-content">
                <List className="ladder-types">
                    <ListItem selected={showSeasonInfo} disabled={disabled} onClick={() => setShowSeasonInfo(true)}>{strings.get("gui:ladderseasoninfo")}</ListItem>
                    {ladderTypes.map(ladderType => (
                        <ListItem key={ladderType} selected={!showSeasonInfo && selectedLadderType === ladderType} disabled={disabled} onClick={() => {
                            setShowSeasonInfo(false);
                            onLadderTypeSelect(ladderType);
                        }}>{strings.get(LADDER_TYPE_LABELS.get(ladderType) ?? ladderType)}</ListItem>
                    ))}
                </List>
                {showSeasonInfo && seasonDetails ? (
                    <div className="season-info">
                        <header>
                            <h2>{formatSeasonName(seasonDetails.name, strings)}</h2>
                            {seasonDetails.startTime !== undefined && seasonDetails.endTime !== undefined && (
                                <p>{formatDate(seasonDetails.startTime) + " - " + formatDate(seasonDetails.endTime)}</p>
                            )}
                        </header>
                        {seasonDetails.topTierStartTime !== undefined && (
                            <div className="item">
                                <span className="label">{strings.get("gui:laddertoptierstart")}</span>
                                <span className="label">{formatDate(seasonDetails.topTierStartTime)}</span>
                            </div>
                        )}
                        {seasonDetails.nextTopTierDemoteTime !== undefined && (
                            <div className="item">
                                <span className="label">{strings.get("gui:laddertoptierdemotions")}</span>
                                <span className="label">{formatTime(seasonDetails.nextTopTierDemoteTime)}</span>
                            </div>
                        )}
                        {seasonDetails.nextTopTierPromoteTime !== undefined && (
                            <div className="item">
                                <span className="label">{strings.get("gui:laddertoptierpromotions")}</span>
                                <span className="label">{formatTime(seasonDetails.nextTopTierPromoteTime)}</span>
                            </div>
                        )}
                        {seasonDetails.lockTime !== undefined && (
                            <div className="item">
                                <span className="label">{strings.get("gui:ladderseasonlock")}</span>
                                <span className="value">{formatDate(seasonDetails.lockTime)}</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <LadderTable players={players} highlightPlayer={highlightPlayer} ladderType={selectedLadder?.type ?? ladders?.[0].type} region={serverRegion} season={selectedSeason} showPoints={hasPoints} showMmr={hasMmr} strings={strings} hasPrevPage={hasPrevPage} hasNextPage={hasNextPage} disabled={disabled} onFirstPageClick={onFirstPageClick} onPrevPageClick={onPrevPageClick} onNextPageClick={onNextPageClick} onLastPageClick={onLastPageClick}/>
                )}
            </div>
        </div>
    );
};
