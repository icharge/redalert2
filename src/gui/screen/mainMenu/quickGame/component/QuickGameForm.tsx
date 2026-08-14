import React from "react";
import ButtonSelect from "@/gui/component/ButtonSelect";
import { Option } from "@/gui/component/Option";
import { CountrySelect } from "@/gui/component/CountrySelect";
import { ColorSelect } from "@/gui/component/ColorSelect";
import { Image } from "@/gui/component/Image";
import { RankIndicator } from "@/gui/screen/mainMenu/lobby/component/RankIndicator";
import { QuickGameChat } from "@/gui/screen/mainMenu/quickGame/component/QuickGameChat";
import { LadderQueueType } from "@/network/ladder/wladderConfig";
import classNames from "classnames";
interface QuickGameFormProps {
    strings: any;
    disabled: boolean;
    playerName: string;
    playerProfile: any;
    unrankedEnabled: boolean;
    ranked: boolean;
    type: string;
    availableTypes: string[];
    enabledTypes: string[];
    chatProps: any;
    onRankedChange: (ranked: boolean) => void;
    onTypeChange: (type: string) => void;
    countryUiNames: Map<string, string>;
    countryUiTooltips: Map<string, string>;
    country: string;
    availableCountries: string[];
    color: string;
    availableColors: string[];
    partyState?: {
        members: Array<{ name: string }>;
    };
    partySize: number;
    noInvites: boolean;
    onNoInvitesChange?: (value: boolean) => void;
    onInvitePlayer?: () => void;
    onCountrySelect: (country: string) => void;
    onColorSelect: (color: string) => void;
}
const RANK_LABELS = new Map<string, string>([
    ["Private", "GUI:RankPrivate"],
    ["Corporal", "GUI:RankCorporal"],
    ["Sergeant", "GUI:RankSergeant"],
    ["Lieutenant", "GUI:RankLieutenant"],
    ["Major", "GUI:RankMajor"],
    ["Colonel", "GUI:RankColonel"],
    ["BrigGeneral", "GUI:RankBrigGeneral"],
    ["General", "GUI:RankGeneral"],
    ["FiveStarGeneral", "GUI:RankFiveStar"],
    ["CommanderInChief", "GUI:RankCmdInChief"],
]);
export const QuickGameForm: React.FC<QuickGameFormProps> = ({ strings, disabled, playerName, playerProfile, unrankedEnabled, ranked, type, availableTypes, enabledTypes, chatProps, onRankedChange, onTypeChange, countryUiNames, countryUiTooltips, country, availableCountries, color, availableColors, partyState, partySize, noInvites, onNoInvitesChange, onInvitePlayer, onCountrySelect, onColorSelect, }) => {
    return React.createElement("div", { className: "qm-form" }, React.createElement("div", { className: "qm-top" }, React.createElement("div", { className: "opts" }, React.createElement("div", { className: "item qm-game-type-item" }, React.createElement("label", null, React.createElement("span", { className: "label" }, strings.get("GUI:QuickMatchGameMode")), React.createElement("div", { className: "qm-game-type" }, React.createElement(ButtonSelect, {
        initialValue: type,
        onSelect: (value: string) => onTypeChange(value),
        disabled: disabled,
    }, availableTypes.map((typeValue) => React.createElement(Option, {
        value: typeValue,
        label: typeValue,
        key: typeValue,
        disabled: !enabledTypes.includes(typeValue) || (partySize === 2 && typeValue === LadderQueueType.Solo1v1),
    }))), React.createElement(ButtonSelect, {
        initialValue: String(Number(ranked)),
        onSelect: (value: string) => onRankedChange(Boolean(Number(value))),
        disabled: disabled,
    }, React.createElement(Option, {
        value: "1",
        label: strings.get("GUI:Ranked"),
        key: "1",
    }), React.createElement(Option, {
        value: "0",
        disabled: !unrankedEnabled,
        label: strings.get("GUI:Unranked"),
        key: "0",
    }))))), React.createElement("div", { className: "item" }, React.createElement("label", null, React.createElement("span", { className: "label" }, strings.get("GUI:PreferredCountry")), React.createElement(CountrySelect, {
        countryUiNames: countryUiNames,
        countryUiTooltips: countryUiTooltips,
        country: country,
        availableCountries: availableCountries,
        disabled: disabled,
        strings: strings,
        onSelect: onCountrySelect,
    }))), React.createElement("div", { className: "item" }, React.createElement("label", null, React.createElement("span", { className: "label" }, strings.get("GUI:PreferredColor")), React.createElement(ColorSelect, {
        color: color,
        availableColors: availableColors,
        disabled: disabled,
        strings: strings,
        onSelect: onColorSelect,
    }))), partyState && partyState.members.length > 0
        ? React.createElement("div", { className: "item" }, React.createElement("label", null, React.createElement("span", { className: "label" }, strings.get("GUI:CurrentParty")), React.createElement("div", { className: "party-info" }, React.createElement("div", { className: "party-members" }, React.createElement("span", null, partyState.members.map((member) => member.name).join(", "))))))
        : React.createElement(React.Fragment, null, React.createElement("div", { className: "item" }, React.createElement("label", null, React.createElement("span", { className: "label" }, strings.get("GUI:CurrentParty")), React.createElement("button", {
            className: "dialog-button",
            disabled: disabled,
            onClick: onInvitePlayer,
        }, strings.get("GUI:InvitePlayerButton")))), React.createElement("div", { className: "item party-noinvites" }, React.createElement("label", null, React.createElement("span", { className: "label" }, strings.get("GUI:PartyNoInvites")), React.createElement("input", {
            type: "checkbox",
            checked: noInvites,
            onChange: (e) => onNoInvitesChange?.(e.target.checked),
            disabled: disabled,
        })))), React.createElement("fieldset", { className: "qm-profile" }, React.createElement("legend", null, playerProfile?.name ?? playerName), playerProfile?.rank === undefined
            ? playerProfile
                ? React.createElement("div", { className: "item placement" }, strings.get("GUI:LadderPlacement", playerProfile.placementMatchesLeft))
                : React.createElement("div", null)
            : React.createElement(React.Fragment, null, React.createElement("div", { className: "player-rank" }, React.createElement("div", { className: "rank-name" }, React.createElement(RankIndicator, {
                playerProfile: playerProfile,
                strings: strings,
            }), " ", strings.get(RANK_LABELS.get(playerProfile.rankType) ?? playerProfile.rankType)), React.createElement("div", { className: "rank-number" }, strings.get("GUI:Rank"), " ", playerProfile.rank)), playerProfile.promotionProgress && React.createElement("div", { className: classNames("item", "promo-progress", { demotion: playerProfile.promotionProgress.demotion }) }, React.createElement("span", { className: "label" }, strings.get("GUI:LadderPromoProgress")), React.createElement("span", { className: "value" }, React.createElement("div", { className: "next-rank" }, strings.get(RANK_LABELS.get(playerProfile.promotionProgress.rankType) ?? playerProfile.promotionProgress.rankType), playerProfile.promotionProgress.demotion
                ? React.createElement("span", { className: "demotion-indicator" }, "▼")
                : React.createElement("span", { className: "promotion-indicator" }, "▲")), React.createElement("progress", { value: playerProfile.promotionProgress.progress, max: 1 }))), React.createElement("hr", null), React.createElement("div", { className: "item" }, React.createElement("span", { className: "label" }, strings.get("GUI:LadderWins")), React.createElement("span", { className: "value" }, playerProfile.wins ?? strings.get("GUI:UnknownStats"))), playerProfile.points !== undefined && React.createElement("div", { className: "item" }, React.createElement("span", { className: "label" }, strings.get("GUI:LadderPoints")), React.createElement("span", { className: "value" }, playerProfile.points)), playerProfile.bonusPool !== undefined && React.createElement("div", { className: "item" }, React.createElement("span", { className: "label" }, strings.get("GUI:ProfileBonusPool")), React.createElement("span", { className: "value" }, playerProfile.bonusPool)), playerProfile.mmr !== undefined && React.createElement("div", { className: "item" }, React.createElement("span", { className: "label" }, strings.get("GUI:ProfileMMR")), React.createElement("span", { className: "value" }, playerProfile.mmr, playerProfile.provisionalMmr !== undefined && React.createElement("span", {
                className: "info",
                title: strings.get("gui:profileprovmmr") + " " + playerProfile.provisionalMmr,
            }, React.createElement(Image, { src: "info.png" })))))))), React.createElement("div", { className: "qm-bottom" }, React.createElement(QuickGameChat, chatProps)));
};
