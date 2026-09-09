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
/** Subset of MapCatalogEntry (see @/network/MapCatalogService) that the Community Browser table renders. */
interface CommunityMapEntry {
    sha256: string;
    filename: string;
    title: string;
    description: string;
    maxPlayers: number;
    gameModes: string[];
    theater: string;
    downloads: number;
    stats: {
        plays: number;
        ratingAvg: number;
        ratingCount: number;
    };
}
interface MapSelPrototypeProps {
    strings: any;
    gameModes: GameMode[];
    maps: MapData[];
    selectedGameMode: GameMode;
    selectedMapName: string;
    onSelectGameMode: (gameMode: GameMode) => void;
    onSelectMap: (mapName: string) => void;
    communityMaps?: CommunityMapEntry[];
    communityMapsLoading?: boolean;
    communityMapsError?: string;
    onActivateCommunityTab: () => void;
}
type TabId = "official" | "community" | "featured";
const TABS: { id: TabId; label: string }[] = [
    { id: "official", label: "Official Maps" },
    { id: "community", label: "Community Browser" },
    { id: "featured", label: "Featured" },
];
enum SortType {
    None = "",
    NameAsc = "nameAsc",
    NameDesc = "nameDesc",
    RatingDesc = "ratingDesc",
    RatingAsc = "ratingAsc",
}
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
function sortMaps(maps: MapData[], sortType: SortType): MapData[] {
    switch (sortType) {
        case SortType.None:
            return maps;
        case SortType.NameAsc:
            return maps.sort((a, b) => a.mapTitle.localeCompare(b.mapTitle));
        case SortType.NameDesc:
            return maps.sort((a, b) => b.mapTitle.localeCompare(a.mapTitle));
        case SortType.RatingDesc:
            return maps.sort((a, b) => getMockMapStats(b.mapName).rating - getMockMapStats(a.mapName).rating);
        case SortType.RatingAsc:
            return maps.sort((a, b) => getMockMapStats(a.mapName).rating - getMockMapStats(b.mapName).rating);
        default:
            throw new Error(`Unsupported sort type "${sortType}"`);
    }
}
export const MapSelPrototype: React.FC<MapSelPrototypeProps> = ({
    strings,
    gameModes,
    maps,
    selectedGameMode,
    selectedMapName,
    onSelectGameMode,
    onSelectMap,
    communityMaps,
    communityMapsLoading,
    communityMapsError,
    onActivateCommunityTab,
}) => {
    const selectedRef = useRef<HTMLDivElement>(null);
    const [activeTab, setActiveTab] = useState<TabId>("official");
    const [searchFilter, setSearchFilter] = useState<string>("");
    const [sortType, setSortType] = useState<SortType>(SortType.None);
    const [filteredMaps, setFilteredMaps] = useState<MapData[]>(maps);
    const [selectedCommunitySha, setSelectedCommunitySha] = useState<string | undefined>(undefined);
    useEffect(() => {
        const filtered = maps.filter((map) => map.mapTitle.toLowerCase().includes(searchFilter.toLowerCase()));
        setFilteredMaps(sortMaps(filtered, sortType));
    }, [maps, searchFilter, sortType]);
    useEffect(() => {
        const timeout = setTimeout(() => selectedRef.current?.scrollIntoView({ block: "nearest" }), 50);
        return () => clearTimeout(timeout);
    }, [maps]);
    useEffect(() => {
        if (activeTab === "community") {
            onActivateCommunityTab();
        }
    }, [activeTab]);
    const selectedMap = maps.find((map) => map.mapName === selectedMapName);
    const filteredCommunityMaps = (communityMaps ?? []).filter((entry) => (entry.title || entry.filename).toLowerCase().includes(searchFilter.toLowerCase()));
    const selectedCommunityMap = filteredCommunityMaps.find((entry) => entry.sha256 === selectedCommunitySha);
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
            {activeTab === "featured" ? (
                <div className="map-sel-proto-empty-state">
                    Featured maps aren't wired up in this prototype yet.
                </div>
            ) : activeTab === "community" ? (
                communityMapsLoading ? (
                    <div className="map-sel-proto-empty-state">Loading community maps…</div>
                ) : communityMapsError ? (
                    <div className="map-sel-proto-empty-state">
                        {communityMapsError}{" "}
                        <span className="map-sel-proto-retry" onClick={onActivateCommunityTab}>Retry</span>
                    </div>
                ) : !communityMaps || communityMaps.length === 0 ? (
                    <div className="map-sel-proto-empty-state">No community maps have been uploaded yet.</div>
                ) : (
                    <>
                        <ListHeader className="map-sel-proto-row map-sel-proto-header">
                            <span className="map-col-name">Map Name</span>
                            <span className="map-col-rating">Rating</span>
                            <span className="map-col-stats">Stats</span>
                            <span className="map-col-tags">Tags</span>
                        </ListHeader>
                        <List className="map-sel-proto-list" tooltip={strings.get("STT:ScenarioListMaps")}>
                            {filteredCommunityMaps.map((entry) => {
                                const isSelected = entry.sha256 === selectedCommunitySha;
                                const title = entry.title || entry.filename;
                                return (
                                    <ListItem
                                        key={entry.sha256}
                                        className="map-sel-proto-row"
                                        selected={isSelected}
                                        onClick={() => setSelectedCommunitySha(entry.sha256)}
                                    >
                                        <span className="map-col-name" title={title}>{title}</span>
                                        <span className="map-col-rating" title={`${entry.stats.ratingAvg.toFixed(1)} / 5 (${entry.stats.ratingCount})`}>{renderStars(entry.stats.ratingAvg)}</span>
                                        <span className="map-col-stats">{entry.stats.plays} plays · {entry.downloads} DLs</span>
                                        <span className="map-col-tags">{entry.theater || "Unknown Theater"} · {entry.maxPlayers}p</span>
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
                        </div>
                        <div className="map-sel-proto-description">
                            {selectedCommunityMap && (
                                <>
                                    <span className="map-sel-proto-desc-title">{selectedCommunityMap.title || selectedCommunityMap.filename}: </span>
                                    <span className="map-sel-proto-desc-body">{selectedCommunityMap.description || "No description provided."}</span>
                                </>
                            )}
                        </div>
                    </>
                )
            ) : (
                <>
                    <div className="map-sel-proto-toolbar">
                        <div className="map-sel-proto-filter-group">
                            <span className="map-sel-proto-filter-label">{strings.get("GUI:GameType")}:</span>
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
                        <div className="map-sel-proto-sort-group">
                            <span className="map-sel-proto-sort-icon" data-r-tooltip={strings.get("STT:SortBy")}>⇵</span>
                            <Select
                                initialValue={sortType}
                                onSelect={(value: SortType) => setSortType(value)}
                                className="map-sel-proto-sort-select"
                            >
                                <Option value={SortType.None} label={strings.get("TS:SortNone")} />
                                <Option value={SortType.NameAsc} label={strings.get("TS:SortName") + " ↓"} />
                                <Option value={SortType.NameDesc} label={strings.get("TS:SortName") + " ↑"} />
                                <Option value={SortType.RatingDesc} label="Rating ↓" />
                                <Option value={SortType.RatingAsc} label="Rating ↑" />
                            </Select>
                        </div>
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
