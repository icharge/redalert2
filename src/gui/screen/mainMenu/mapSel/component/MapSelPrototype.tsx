import React, { useEffect, useRef, useState } from "react";
import { List, ListHeader, ListItem } from "@/gui/component/List";
import { Select } from "@/gui/component/Select";
import { Option } from "@/gui/component/Option";

// Prototype-only content frame for the "Select Engagement" redesign
// (test section, see MapSelPrototypeScreen). Ratings/plays/DLs/tags below
// are deterministic mock values derived from the map name — this repo's
// map data model has no such fields — so the layout can be judged without
// wiring a real community-stats backend first.

interface MapData {
    mapName: string;
    mapTitle: string;
    maxSlots: number;
}
interface GameMode {
    id: number;
    label: string;
    description?: string;
}
interface MapSelPrototypeProps {
    strings: any;
    gameModes: GameMode[];
    maps: MapData[];
    selectedGameMode: GameMode;
    selectedMapName: string;
    onSelectGameMode: (gameMode: GameMode) => void;
    onSelectMap: (mapName: string) => void;
}
type TabId = "official" | "community" | "featured";
const TABS: { id: TabId; label: string }[] = [
    { id: "official", label: "Official Maps" },
    { id: "community", label: "Community Browser" },
    { id: "featured", label: "Featured" },
];
const TAG_POOL = ["Desert Theater", "Naval Combat", "Chokepoint", "Resource Rush", "Community Favorite", "Fan Remake"];
const FLAVOR_POOL = [
    "Control the central resources in this tactical engagement.",
    "A fast-paced skirmish across open terrain.",
    "Narrow chokepoints reward careful unit positioning.",
    "Abundant resources make for aggressive early expansion.",
];
function hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}
interface MockMapStats {
    rating: number;
    plays: string;
    downloads: string;
    tags: string[];
}
function getMockMapStats(mapName: string): MockMapStats {
    const hash = hashString(mapName);
    return {
        rating: 3 + (hash % 21) / 10,
        plays: `${10 + (hash % 60)}k`,
        downloads: `${(1 + (hash % 20) / 10).toFixed(1)}k`,
        tags: [TAG_POOL[hash % TAG_POOL.length]],
    };
}
function renderStars(rating: number): string {
    const rounded = Math.min(5, Math.max(0, Math.round(rating)));
    return "★★★★★".slice(0, rounded) + "☆☆☆☆☆".slice(0, 5 - rounded);
}
function describeMap(map: MapData): string {
    const hash = hashString(map.mapName);
    return `${FLAVOR_POOL[hash % FLAVOR_POOL.length]} (${map.maxSlots} players)`;
}
export const MapSelPrototype: React.FC<MapSelPrototypeProps> = ({
    strings,
    gameModes,
    maps,
    selectedGameMode,
    selectedMapName,
    onSelectGameMode,
    onSelectMap,
}) => {
    const selectedRef = useRef<HTMLDivElement>(null);
    const [activeTab, setActiveTab] = useState<TabId>("official");
    const [searchFilter, setSearchFilter] = useState<string>("");
    const [filteredMaps, setFilteredMaps] = useState<MapData[]>(maps);
    useEffect(() => {
        setFilteredMaps(maps.filter((map) => map.mapTitle.toLowerCase().includes(searchFilter.toLowerCase())));
    }, [maps, searchFilter]);
    useEffect(() => {
        const timeout = setTimeout(() => selectedRef.current?.scrollIntoView({ block: "nearest" }), 50);
        return () => clearTimeout(timeout);
    }, [maps]);
    const selectedMap = maps.find((map) => map.mapName === selectedMapName);
    return (
        <div className="map-sel-proto-form">
            <div className="map-sel-proto-title">{strings.get("GUI:SelectEngagement")}</div>
            <div className="map-sel-proto-tabs">
                {TABS.map((tab) => (
                    <div
                        key={tab.id}
                        className={"map-sel-proto-tab" + (activeTab === tab.id ? " active" : "")}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                    </div>
                ))}
            </div>
            {activeTab !== "official" ? (
                <div className="map-sel-proto-empty-state">
                    {activeTab === "community"
                        ? "Community Browser isn't wired up in this prototype yet."
                        : "Featured maps aren't wired up in this prototype yet."}
                </div>
            ) : (
                <>
                    <div className="map-sel-proto-toolbar">
                        <span className="map-sel-proto-sort-icon" data-r-tooltip={strings.get("STT:SortBy")}>⇵</span>
                        <span className="map-sel-proto-filter-label">Filter:</span>
                        <Select
                            initialValue={selectedGameMode.id}
                            onSelect={(id: number) => {
                                const gameMode = gameModes.find((mode) => mode.id === id);
                                if (gameMode) {
                                    onSelectGameMode(gameMode);
                                }
                            }}
                            className="map-sel-proto-filter-select"
                        >
                            {gameModes.map((gameMode) => (
                                <Option key={gameMode.id} value={gameMode.id} label={strings.get(gameMode.label)} />
                            ))}
                        </Select>
                    </div>
                    <ListHeader className="map-sel-proto-row map-sel-proto-header">
                        <span className="map-col-name">Map Name</span>
                        <span className="map-col-rating">Rating</span>
                        <span className="map-col-stats">Stats</span>
                        <span className="map-col-tags">Tags</span>
                    </ListHeader>
                    <List className="map-sel-proto-list" tooltip={strings.get("STT:ScenarioListMaps")}>
                        {filteredMaps.map((map) => {
                            const isSelected = map.mapName === selectedMapName;
                            const stats = getMockMapStats(map.mapName);
                            return (
                                <ListItem
                                    key={map.mapName}
                                    className="map-sel-proto-row"
                                    selected={isSelected}
                                    innerRef={isSelected ? selectedRef : null}
                                    onClick={() => onSelectMap(map.mapName)}
                                    onDoubleClick={() => onSelectMap(map.mapName)}
                                >
                                    <span className="map-col-name" title={map.mapTitle}>{map.mapTitle}</span>
                                    <span className="map-col-rating" title={`${stats.rating.toFixed(1)} / 5`}>{renderStars(stats.rating)}</span>
                                    <span className="map-col-stats">{stats.plays} plays · {stats.downloads} DLs</span>
                                    <span className="map-col-tags">{stats.tags.join(", ")} · {map.maxSlots}p</span>
                                </ListItem>
                            );
                        })}
                    </List>
                    <div className="map-sel-proto-search-row">
                        <label className="map-sel-proto-search">
                            <span>{strings.get("GUI:Search")}</span>
                            <input
                                type="text"
                                className="new-message"
                                value={searchFilter}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchFilter(e.target.value)}
                            />
                        </label>
                        <label className="map-sel-proto-tag-search">
                            <span>Community Tag</span>
                            <input type="text" className="new-message" disabled placeholder="Official maps only" />
                        </label>
                    </div>
                    <div className="map-sel-proto-description">
                        {selectedMap && (
                            <>
                                <span className="map-sel-proto-desc-title">{selectedMap.mapTitle}: </span>
                                <span className="map-sel-proto-desc-body">{describeMap(selectedMap)}</span>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
