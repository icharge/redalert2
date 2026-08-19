import React, { useState, useRef, useEffect } from 'react';
import classNames from 'classnames';
import { List, ListHeader, ListItem } from '@/gui/component/List';
interface ReplayRow {
    id: string;
    name: string;
    timestamp: number;
    size?: number;
}
interface MapRow {
    fileName: string;
    title: string;
    size?: number;
}
interface ModRow {
    id: string;
    name: string;
    size?: number;
}
interface Strings {
    get(key: string, ...args: any[]): string;
}
function formatSize(bytes?: number): string {
    if (bytes === undefined) {
        return '';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export interface ManageGameProps {
    strings: Strings;
    replays?: ReplayRow[];
    maps?: MapRow[];
    mods?: ModRow[];
    selectedReplayIds: Set<string>;
    selectedMapNames: Set<string>;
    selectedModIds: Set<string>;
    onToggleReplay: (id: string) => void;
    onToggleMap: (fileName: string) => void;
    onToggleMod: (id: string) => void;
    onSelectAllReplays: (ids: string[]) => void;
    onSelectAllMaps: (fileNames: string[]) => void;
    onSelectAllMods: (ids: string[]) => void;
    onResetGameFiles: () => void;
    onResetAll: () => void;
}
const COLLAPSE_THRESHOLD = 5;
const SelectAllCheckbox: React.FC<{
    allSelected: boolean;
    someSelected: boolean;
    disabled: boolean;
    onChange: () => void;
}> = ({ allSelected, someSelected, disabled, onChange }) => {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) {
            ref.current.indeterminate = someSelected && !allSelected;
        }
    }, [someSelected, allSelected]);
    return (<input ref={ref} type="checkbox" className={classNames("manage-game-select-all", { "semi-checked-left": someSelected && !allSelected })} checked={allSelected} disabled={disabled} onClick={(e) => e.stopPropagation()} onChange={onChange}/>);
};
function TreeSection<T>({ id, label, items, loadingText, emptyText, expanded, onToggleExpand, renderRow, isSelected, onSelectAll, }: {
    id: string;
    label: string;
    items?: T[];
    loadingText: string;
    emptyText: string;
    expanded: boolean;
    onToggleExpand: (id: string) => void;
    renderRow: (item: T) => React.ReactNode;
    isSelected: (item: T) => boolean;
    onSelectAll: (selectAll: boolean) => void;
}) {
    const count = items?.length ?? 0;
    const selectedCount = items?.filter(isSelected).length ?? 0;
    const allSelected = count > 0 && selectedCount === count;
    const someSelected = selectedCount > 0;
    const collapsible = count > COLLAPSE_THRESHOLD;
    const isOpen = !collapsible || expanded;
    return (<>
        <ListHeader className={classNames("manage-game-tree-header", { collapsible })} onClick={collapsible ? () => onToggleExpand(id) : undefined}>
            <SelectAllCheckbox allSelected={allSelected} someSelected={someSelected} disabled={count === 0} onChange={() => onSelectAll(!allSelected)}/>
            <span className={classNames("manage-game-tree-toggle", { open: isOpen, hidden: !collapsible })}/>
            <span className="manage-game-tree-label">{label}</span>
            <span className="manage-game-tree-count">({count})</span>
        </ListHeader>
        {items === undefined ? (<ListItem className="manage-game-empty">{loadingText}</ListItem>)
            : count === 0 ? (<ListItem className="manage-game-empty">{emptyText}</ListItem>)
                : isOpen ? items.map(renderRow) : null}
    </>);
}
export const ManageGame: React.FC<ManageGameProps> = ({ strings, replays, maps, mods, selectedReplayIds, selectedMapNames, selectedModIds, onToggleReplay, onToggleMap, onToggleMod, onSelectAllReplays, onSelectAllMaps, onSelectAllMods, onResetGameFiles, onResetAll, }) => {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const toggleExpand = (id: string) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
            next.delete(id);
        }
        else {
            next.add(id);
        }
        return next;
    });
    return (<div className="manage-game-form">
        <List title={strings.get("GUI:ManageGame")} className="manage-game-list">
            <TreeSection id="replays" label={strings.get("GUI:Replays")} items={replays} loadingText={strings.get("GUI:LoadingEx")} emptyText={strings.get("GUI:NoReplaysFound")} expanded={expanded.has("replays")} onToggleExpand={toggleExpand} isSelected={(replay: ReplayRow) => selectedReplayIds.has(replay.id)} onSelectAll={(selectAll) => onSelectAllReplays(selectAll ? (replays ?? []).map((r) => r.id) : [])} renderRow={(replay: ReplayRow) => (<ListItem key={replay.id} className="manage-game-item manage-game-tree-item">
                <label>
                    <input type="checkbox" checked={selectedReplayIds.has(replay.id)} onChange={() => onToggleReplay(replay.id)}/>
                    <span className="manage-game-item-name">{replay.name}</span>
                    <span className="manage-game-item-size">{formatSize(replay.size)}</span>
                    <span className="manage-game-item-meta">{new Date(replay.timestamp).toLocaleString()}</span>
                </label>
            </ListItem>)}/>
            <TreeSection id="maps" label={strings.get("GUI:Maps")} items={maps} loadingText={strings.get("GUI:LoadingEx")} emptyText={strings.get("GUI:NoMapsFound")} expanded={expanded.has("maps")} onToggleExpand={toggleExpand} isSelected={(map: MapRow) => selectedMapNames.has(map.fileName)} onSelectAll={(selectAll) => onSelectAllMaps(selectAll ? (maps ?? []).map((m) => m.fileName) : [])} renderRow={(map: MapRow) => (<ListItem key={map.fileName} className="manage-game-item manage-game-tree-item">
                <label>
                    <input type="checkbox" checked={selectedMapNames.has(map.fileName)} onChange={() => onToggleMap(map.fileName)}/>
                    <span className="manage-game-item-name">{map.title}</span>
                    <span className="manage-game-item-size">{formatSize(map.size)}</span>
                </label>
            </ListItem>)}/>
            <TreeSection id="mods" label={strings.get("GUI:Mods")} items={mods} loadingText={strings.get("GUI:LoadingEx")} emptyText={strings.get("GUI:NoModsInstalled")} expanded={expanded.has("mods")} onToggleExpand={toggleExpand} isSelected={(mod: ModRow) => selectedModIds.has(mod.id)} onSelectAll={(selectAll) => onSelectAllMods(selectAll ? (mods ?? []).map((m) => m.id) : [])} renderRow={(mod: ModRow) => (<ListItem key={mod.id} className="manage-game-item manage-game-tree-item">
                <label>
                    <input type="checkbox" checked={selectedModIds.has(mod.id)} onChange={() => onToggleMod(mod.id)}/>
                    <span className="manage-game-item-name">{mod.name}</span>
                    <span className="manage-game-item-size">{formatSize(mod.size)}</span>
                </label>
            </ListItem>)}/>
        </List>
        <div className="manage-game-danger-row">
            <div className="manage-game-danger-zone">
                <div className="manage-game-danger-title">{strings.get("GUI:GameFiles")}</div>
                <p className="manage-game-danger-desc">{strings.get("GUI:GameFilesDesc")}</p>
                <button type="button" className="dialog-button" onClick={onResetGameFiles}>
                    {strings.get("GUI:ResetGameFiles")}
                </button>
            </div>
            <div className="manage-game-danger-zone">
                <div className="manage-game-danger-title">{strings.get("GUI:ResetAllTitle")}</div>
                <p className="manage-game-danger-desc">{strings.get("GUI:ResetAllDesc")}</p>
                <button type="button" className="dialog-button" onClick={onResetAll}>
                    {strings.get("GUI:ResetAll")}
                </button>
            </div>
        </div>
    </div>);
};
