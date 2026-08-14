import React, { useState } from "react";
import classNames from "classnames";
import { RankIndicator } from "@/gui/screen/mainMenu/lobby/component/RankIndicator";
import { PlayerRankType } from "@/network/ladder/PlayerRankType";
import ChannelOpIndicator from "./ChannelOpIndicator";
import { PlayerContextMenu, type PlayerContextMenuItem } from "./PlayerContextMenu";
interface ChannelUserProps {
    user: {
        name: string;
        operator?: boolean;
    };
    playerProfile?: {
        name: string;
        rankType: PlayerRankType;
        rank?: number;
    };
    strings: {
        get: (key: string) => string;
    };
    menuItems?: PlayerContextMenuItem[];
    localUsername?: string;
    onClick?: () => void;
}
const RANK_LABELS = new Map<PlayerRankType, string>()
    .set(PlayerRankType.Private, "GUI:RankPrivate")
    .set(PlayerRankType.Corporal, "GUI:RankCorporal")
    .set(PlayerRankType.Sergeant, "GUI:RankSergeant")
    .set(PlayerRankType.Lieutenant, "GUI:RankLieutenant")
    .set(PlayerRankType.Major, "GUI:RankMajor")
    .set(PlayerRankType.Colonel, "GUI:RankColonel")
    .set(PlayerRankType.BrigGeneral, "GUI:RankBrigGeneral")
    .set(PlayerRankType.General, "GUI:RankGeneral")
    .set(PlayerRankType.FiveStarGeneral, "GUI:RankFiveStar")
    .set(PlayerRankType.CommanderInChief, "GUI:RankCmdInChief");
const ChannelUser: React.FC<ChannelUserProps> = ({ user, playerProfile, strings, menuItems = [], localUsername, onClick, }) => {
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const isSelf = user.name === localUsername;
    let tooltip = user.name;
    if (user.operator) {
        tooltip += " : " + strings.get("TXT_OPER");
    }
    tooltip +=
        playerProfile?.rank !== undefined
            ? " : " + strings.get(RANK_LABELS.get(playerProfile.rankType)!)
            : " : " + strings.get("TXT_UNRANKED");
    const items = menuItems.map((item) => ({
        label: item.label,
        disabled: item.disabled,
        onClick: () => {
            item.onClick();
            setIsMenuOpen(false);
        },
    }));
    return (<div className={classNames("player", { operator: user.operator, "menu-open": isMenuOpen })} data-r-tooltip={tooltip} onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isSelf && items.length > 0) {
                setIsMenuOpen(true);
            }
            onClick?.();
        }} onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isSelf && items.length > 0) {
                setIsMenuOpen(true);
            }
        }}>
      <ChannelOpIndicator operator={!!user.operator}/>
      <RankIndicator playerProfile={playerProfile} strings={strings}/>
      <span className="player-name-wrapper">
        <span className="player-name">
          {user.name}
        </span>
        {!isSelf && items.length > 0 && (<>
            <span className="player-menu-icon">▼</span>
            {isMenuOpen && (<PlayerContextMenu items={items} onClose={() => setIsMenuOpen(false)}/>)}
          </>)}
      </span>
    </div>);
};
export default ChannelUser;
