import React from "react";
import { List, ListItem } from "@/gui/component/List";
import { RankIndicator } from "@/gui/screen/mainMenu/lobby/component/RankIndicator";
import { PlayerRankType } from "@/network/ladder/PlayerRankType";
import { Strings } from "@/data/Strings";

interface PlayerProfile {
    name: string;
    rankType: PlayerRankType;
}

interface RecentPlayersListProps {
    strings: Strings;
    title: string;
    players: PlayerProfile[];
    onSelect: (name: string) => void;
}

export const RecentPlayersList: React.FC<RecentPlayersListProps> = ({ strings, title, players, onSelect }) => {
    if (!players.length) {
        return null;
    }
    return (<List className="recent-players-list" title={title}>
        {players.map((player) => (<ListItem key={player.name} onClick={() => onSelect(player.name)}>
            <RankIndicator playerProfile={player} strings={strings}/>
            {" "}{player.name}
        </ListItem>))}
    </List>);
};
