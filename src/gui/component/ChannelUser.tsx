import React from "react";
import classNames from "classnames";
import { RankIndicator } from "@/gui/screen/mainMenu/lobby/component/RankIndicator";
import { PlayerRankType } from "@/network/ladder/PlayerRankType";
import ChannelOpIndicator from "./ChannelOpIndicator";
interface ChannelUserProps {
    user: {
        name: string;
        operator?: boolean;
    };
    playerProfile?: {
        name: string;
        rankType: PlayerRankType;
    };
    strings: {
        get: (key: string) => string;
    };
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
const ChannelUser: React.FC<ChannelUserProps> = ({ user, playerProfile, strings, onClick, }) => {
    let tooltip = user.name;
    if (user.operator) {
        tooltip += " : " + strings.get("TXT_OPER");
    }
    tooltip +=
        playerProfile && playerProfile.rankType !== PlayerRankType.None
            ? " : " + strings.get(RANK_LABELS.get(playerProfile.rankType)!)
            : " : " + strings.get("TXT_UNRANKED");
    return (<div className={classNames("player", { operator: user.operator })} data-r-tooltip={tooltip} onClick={onClick}>
      <ChannelOpIndicator operator={!!user.operator}/>
      <RankIndicator playerProfile={playerProfile} strings={strings}/>
      {user.name}
    </div>);
};
export default ChannelUser;
