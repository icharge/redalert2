import React from 'react';
import classNames from 'classnames';
import { HtmlReactElement } from '../HtmlReactElement';
import { Dialog, type DialogProps } from './Dialog';
import { GameResForm, type GameResFormProps } from './GameResForm';
import { FileSystemUtil } from '../../engine/gameRes/FileSystemUtil';
import type { Viewport } from '../Viewport';
import type { Strings } from '../../data/Strings';
interface FsAccessLibraryShim {
    polyfillDataTransferItem: () => Promise<void>;
    showDirectoryPicker: (options?: any) => Promise<FileSystemDirectoryHandle>;
}
export type GameResSourceSelection = FileSystemDirectoryHandle | FileSystemFileHandle | URL | undefined;
export class GameResBoxApi {
    private viewport: Viewport;
    private strings: Strings;
    private rootEl: HTMLElement;
    private fsAccessLib: FsAccessLibraryShim;
    constructor(viewport: Viewport, strings: Strings, rootEl: HTMLElement, fsAccessLib: FsAccessLibraryShim) {
        this.viewport = viewport;
        this.strings = strings;
        this.rootEl = rootEl;
        this.fsAccessLib = fsAccessLib;
    }
    async promptForGameRes(defaultArchiveUrl?: string, closable?: boolean): Promise<GameResSourceSelection> {
        await this.fsAccessLib.polyfillDataTransferItem();
        return new Promise<GameResSourceSelection>((resolve) => {
            let dialogElement: HtmlReactElement<DialogProps> | undefined;
            const handleResolve = (selection: GameResSourceSelection) => {
                cleanup();
                resolve(selection);
            };
            const dialogProps: DialogProps = {
                className: classNames("game-res-box"),
                buttons: [] as any[],
                children: React.createElement(GameResForm, {
                    defaultArchiveUrl: defaultArchiveUrl,
                    closable: closable,
                    strings: this.strings,
                    onDrop: async (dataTransfer: DataTransfer) => {
                        if (dataTransfer.items && dataTransfer.items.length > 0) {
                            try {
                                const handle = await (dataTransfer.items[0] as any).getAsFileSystemHandle();
                                if (!handle)
                                    return;
                                handleResolve(handle as FileSystemDirectoryHandle | FileSystemFileHandle);
                            }
                            catch (e) {
                                console.error("Error getting handle from drop:", e);
                            }
                        }
                    },
                    onBrowseFolder: async () => {
                        try {
                            const handle = await this.fsAccessLib.showDirectoryPicker({ _preferPolyfill: true });
                            handleResolve(handle);
                        }
                        catch (e) {
                            console.error("Error browsing folder:", e);
                        }
                    },
                    onBrowseArchive: async () => {
                        try {
                            const handle = await FileSystemUtil.showArchivePicker(this.fsAccessLib as any);
                            handleResolve(handle as FileSystemFileHandle);
                        }
                        catch (e) {
                            console.error("Error browsing archive:", e);
                        }
                    },
                    onDownloadArchive: async (url: URL) => {
                        handleResolve(url);
                    },
                    onClose: () => {
                        handleResolve(undefined);
                    },
                } as GameResFormProps),
                viewport: this.viewport.value,
                zIndex: 101,
            };
            dialogElement = HtmlReactElement.factory(Dialog, dialogProps);
            const handleViewportChange = (viewport: {
                x: number;
                y: number;
                width: number;
                height: number;
            }) => {
                if (dialogElement) {
                    dialogElement.setSize(viewport.width, viewport.height);
                    dialogElement.applyOptions((props) => {
                        props.viewport = viewport;
                    });
                }
            };
            this.viewport.onChange?.subscribe(handleViewportChange);
            const cleanup = () => {
                this.viewport.onChange?.unsubscribe(handleViewportChange);
                if (dialogElement) {
                    const element = dialogElement.getElement();
                    if (element && this.rootEl.contains(element)) {
                        this.rootEl.removeChild(element);
                    }
                    dialogElement.unrender();
                    dialogElement = undefined;
                }
            };
            if (dialogElement) {
                const viewportValue = this.viewport.value;
                dialogElement.setSize(viewportValue.width, viewportValue.height);
                dialogElement.render();
                const elementToAppend = dialogElement.getElement();
                if (elementToAppend) {
                    this.rootEl.appendChild(elementToAppend);
                }
                else {
                    console.error("GameResBoxApi: Dialog element not created for appending.");
                    handleResolve(undefined);
                }
            }
            else {
                console.error("GameResBoxApi: Dialog could not be created.");
                handleResolve(undefined);
            }
        });
    }
}
