import React, { useState, useRef, useEffect, useCallback, DragEvent, PointerEvent } from 'react';
import classNames from 'classnames';
import type { Strings } from '../../data/Strings';

type SetupStep = 'welcome' | 'choices' | 'local' | 'download';
type SourceRoute = 'local' | 'download';

export interface GameResInstallProgress {
    text?: string;
    percent?: number;
}
export interface GameResFormProps {
    closable?: boolean;
    strings: Strings;
    defaultArchiveUrl?: string;
    visualStyle?: 'ra2' | 'win98';
    installProgress?: GameResInstallProgress | null;
    onDownloadArchive: (url: URL) => Promise<void> | void;
    onBrowseFolder: () => Promise<FileSystemHandle | undefined>;
    onBrowseArchive: () => Promise<FileSystemHandle | undefined>;
    onDrop: (dataTransfer: DataTransfer) => Promise<FileSystemHandle | undefined>;
    onProceed: (selection: FileSystemHandle | undefined) => Promise<void> | void;
    onClose?: () => void;
}
export const GameResForm: React.FC<GameResFormProps> = ({ closable, strings, defaultArchiveUrl, visualStyle = 'ra2', installProgress, onDownloadArchive, onBrowseFolder, onBrowseArchive, onDrop, onProceed, onClose, }) => {
    const [dragTarget, setDragTarget] = useState<EventTarget | null | undefined>(null);
    const [step, setStep] = useState<SetupStep>('welcome');
    const [sourceRoute, setSourceRoute] = useState<SourceRoute | null>(null);
    const [pickedSource, setPickedSource] = useState<FileSystemHandle | null>(null);
    const [archiveUrl, setArchiveUrl] = useState<string>(defaultArchiveUrl || '');
    const [urlError, setUrlError] = useState<string>();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const wizardRef = useRef<HTMLDivElement>(null);
    const routeInputRef = useRef<HTMLInputElement>(null);
    const downloadRouteInputRef = useRef<HTMLInputElement>(null);
    const browseFolderRef = useRef<HTMLButtonElement>(null);
    const urlInputRef = useRef<HTMLInputElement>(null);
    const nextButtonRef = useRef<HTMLButtonElement>(null);
    const windowDragState = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

    const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (event.target === dragTarget) {
            setDragTarget(null);
        }
    }, [dragTarget]);

    useEffect(() => {
        if (step === 'welcome') {
            nextButtonRef.current?.focus();
        }
        else if (step === 'choices') {
            const selectedRef = sourceRoute === 'download' ? downloadRouteInputRef : routeInputRef;
            selectedRef.current?.focus();
        }
        else if (step === 'local') {
            browseFolderRef.current?.focus();
        }
        else if (step === 'download') {
            urlInputRef.current?.focus();
        }
    }, [step]);

    useEffect(() => {
        if (!closable || installProgress) {
            return;
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && onClose) {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [closable, installProgress, onClose]);

    useEffect(() => {
        const preventDefault = (event: Event) => event.preventDefault();
        globalThis.addEventListener("drop", preventDefault);
        globalThis.addEventListener("dragover", preventDefault);
        return () => {
            globalThis.removeEventListener("drop", preventDefault);
            globalThis.removeEventListener("dragover", preventDefault);
        };
    }, []);

    const hasOnlyFiles = (dataTransfer: DataTransfer) => dataTransfer.items.length > 0
        && Array.from(dataTransfer.items).every((item) => item.kind === 'file');

    const pickSource = (handle?: FileSystemHandle) => {
        if (handle) {
            setPickedSource(handle);
        }
    };

    const handleBrowseFolder = async () => {
        pickSource(await onBrowseFolder());
    };

    const handleBrowseArchive = async () => {
        pickSource(await onBrowseArchive());
    };

    const handleDropSource = async (dataTransfer: DataTransfer) => {
        pickSource(await onDrop(dataTransfer));
    };

    const handleProceedFromLocal = () => {
        if (pickedSource) {
            void onProceed(pickedSource);
        }
    };

    const submitArchiveUrl = async () => {
        const value = archiveUrl.trim();
        if (!value) {
            return;
        }
        let url: URL;
        try {
            url = new URL(value);
        }
        catch {
            setUrlError(strings.get("ts:gameres_invalid_url"));
            return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            setUrlError(strings.get("ts:gameres_invalid_url"));
            return;
        }
        if (url.protocol === "http:" && window.location.protocol === "https:") {
            setUrlError(strings.get("ts:gameres_insecure_url"));
            return;
        }
        try {
            setUrlError(undefined);
            setIsSubmitting(true);
            await onDownloadArchive(url);
        }
        catch (error) {
            console.error("Unable to start game resource download:", error);
            setUrlError(strings.get("ts:import_failed"));
            setIsSubmitting(false);
        }
    };

    const handleTitlebarPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (closable && (event.target as HTMLElement).closest('button')) {
            return;
        }
        const box = wizardRef.current?.closest('.message-box') as HTMLElement | null;
        if (!box) {
            return;
        }
        const rect = box.getBoundingClientRect();
        box.style.position = 'fixed';
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.transform = 'none';
        box.style.margin = '0';
        windowDragState.current = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };

    const handleTitlebarPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = windowDragState.current;
        const box = wizardRef.current?.closest('.message-box') as HTMLElement | null;
        if (!drag || !box) {
            return;
        }
        box.style.left = `${drag.left + event.clientX - drag.startX}px`;
        box.style.top = `${drag.top + event.clientY - drag.startY}px`;
    };

    const handleTitlebarPointerUp = (event: PointerEvent<HTMLDivElement>) => {
        windowDragState.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
    };

    const renderCancelButton = () => closable ? (<button type="button" className="dialog-button game-res-secondary" onClick={onClose}>
        {strings.get("ts:gameres_cancel")}
    </button>) : null;

    const renderHeader = (title: string, description: string) => (<header className="game-res-wizard-header">
        <div className="game-res-wizard-heading">
            <h2>{title}</h2>
            <p>{description}</p>
        </div>
        {visualStyle === 'win98' && <span className="game-res-wizard-page-icon" aria-hidden="true"/>}
    </header>);

    const renderCloseButton = () => closable ? (<button type="button" className="close-button" onClick={onClose} aria-label="Close"/>) : null;

    const renderWindowControls = () => (<div className="game-res-window-controls">
        <button type="button" className="game-res-window-control game-res-window-close" disabled aria-label="Close"/>
    </div>);

    const renderWindowTitle = (showControls: boolean = true) => (<div className="game-res-window-titlebar" onPointerDown={handleTitlebarPointerDown} onPointerMove={handleTitlebarPointerMove} onPointerUp={handleTitlebarPointerUp} onPointerCancel={handleTitlebarPointerUp}>
        <span>{strings.get("ts:gameres_setup_window_title")}</span>
        {showControls && renderWindowControls()}
    </div>);

    const renderSidebar = () => (<div className="game-res-window-sidebar" aria-hidden="true"/>);

    const renderWin98SidebarChrome = (content: React.ReactNode, showControls: boolean = true) => (<>
        {renderWindowTitle(showControls)}
        <div className="game-res-window-body">
            {renderSidebar()}
            <div className="game-res-window-content">{content}</div>
        </div>
    </>);

    const renderBannerBadge = () => (<span className="game-res-window-banner-badge" aria-hidden="true"/>);

    const renderWin98BannerChrome = (title: string, subtitle: string, content: React.ReactNode, showControls: boolean = true) => (<>
        {renderWindowTitle(showControls)}
        <div className="game-res-window-banner">
            <div className="game-res-window-banner-heading">
                <div className="game-res-window-banner-title">{title}</div>
                <div className="game-res-window-banner-subtitle">{subtitle}</div>
            </div>
            {renderBannerBadge()}
        </div>
        <div className="game-res-window-content-gray">{content}</div>
    </>);

    if (installProgress) {
        const percent = installProgress.percent;
        const content = (<div className="game-res-progress-area">
            <p className="game-res-progress-text" role="status" aria-live="polite">{installProgress.text || strings.get("ts:import_preparing_for_import")}</p>
            <div className={classNames("game-res-progress-bar", { indeterminate: percent === undefined })}>
                <div className="game-res-progress-fill" style={percent !== undefined ? { width: `${Math.min(100, Math.max(0, percent))}%` } : undefined}/>
            </div>
        </div>);
        return (<div ref={wizardRef} className={classNames("game-res-wizard game-res-installing", { "game-res-wizard-win98": visualStyle === 'win98' })}>
            {visualStyle === 'win98'
                ? renderWin98BannerChrome(strings.get("ts:gameres_installing_title"), strings.get("ts:gameres_installing_intro"), content, false)
                : (<>{renderHeader(strings.get("ts:gameres_installing_title"), strings.get("ts:gameres_installing_intro"))}{content}</>)}
        </div>);
    }

    if (step === 'welcome') {
        const content = (<>
            {renderHeader(strings.get("ts:gameres_setup_title"), strings.get("ts:gameres_setup_intro"))}
            {visualStyle === 'win98' && <p className="game-res-setup-note">{strings.get("ts:gameres_setup_recommendation")}</p>}
            {visualStyle === 'win98' && <p className="game-res-setup-note">{strings.get("ts:gameres_setup_next_hint")}</p>}
        </>);
        return (<div ref={wizardRef} className={classNames("game-res-wizard game-res-welcome", { "game-res-wizard-win98": visualStyle === 'win98' })}>
            {visualStyle === 'win98' ? renderWin98SidebarChrome(content) : (<>{renderCloseButton()}{content}</>)}
            <footer className="game-res-wizard-actions">
                <button type="button" ref={nextButtonRef} className="dialog-button game-res-primary" onClick={() => setStep('choices')}>
                    {strings.get("ts:gameres_next")}
                </button>
                {renderCancelButton()}
            </footer>
        </div>);
    }

    if (step === 'choices') {
        const content = (<fieldset className="game-res-source-group game-res-route-group">
            <legend>{strings.get("ts:gameres_local_source_label")}</legend>
            <label className={classNames("game-res-route-option", { selected: sourceRoute === 'local' })}>
                <input ref={routeInputRef} type="radio" name="gameResSource" value="local" checked={sourceRoute === 'local'} onChange={() => setSourceRoute('local')} onKeyDown={(event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                setStep('local');
            }
        }}/>
                <span>
                    <strong>{strings.get("ts:gameres_setup_have_files")}</strong>
                    <small>{strings.get("ts:gameres_setup_have_files_hint")}</small>
                </span>
            </label>
            <label className={classNames("game-res-route-option", { selected: sourceRoute === 'download' })}>
                <input ref={downloadRouteInputRef} type="radio" name="gameResSource" value="download" checked={sourceRoute === 'download'} onChange={() => setSourceRoute('download')} onKeyDown={(event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                setStep('download');
            }
        }}/>
                <span>
                    <strong>{strings.get("ts:gameres_setup_need_download")}</strong>
                    <small>{strings.get("ts:gameres_setup_need_download_hint")}</small>
                </span>
            </label>
        </fieldset>);
        return (<div ref={wizardRef} className={classNames("game-res-wizard game-res-choices", { "game-res-wizard-win98": visualStyle === 'win98' })}>
            {visualStyle === 'win98'
                ? renderWin98BannerChrome(strings.get("ts:gameres_setup_question"), strings.get("ts:gameres_choices_subtitle"), content)
                : (<>{renderCloseButton()}{renderHeader(strings.get("ts:gameres_setup_question"), strings.get("ts:gameres_choices_subtitle"))}{content}</>)}
            <footer className="game-res-wizard-actions">
                <button type="button" className="dialog-button game-res-secondary" onClick={() => setStep('welcome')}>
                    {strings.get("ts:gameres_back")}
                </button>
                <button type="button" className="dialog-button game-res-primary" disabled={!sourceRoute} onClick={() => setStep(sourceRoute || 'choices')}>
                    {strings.get("ts:gameres_next")}
                </button>
                {renderCancelButton()}
            </footer>
        </div>);
    }

    if (step === 'local') {
        const content = (<>
            <fieldset className="game-res-source-group">
                <legend>{strings.get("ts:gameres_local_source_label")}</legend>
                <div className="game-res-source-actions">
                    <div>
                        <button type="button" className="dialog-button game-res-primary" ref={browseFolderRef} onClick={handleBrowseFolder}>
                            {strings.get("ts:gameres_browse_folder")}
                        </button>
                        <p>{strings.get("ts:gameres_folder_hint")}</p>
                    </div>
                    <div>
                        <button type="button" className="dialog-button game-res-secondary" onClick={handleBrowseArchive}>
                            {strings.get("ts:gameres_browse_archive")}
                        </button>
                        <p>{strings.get("ts:gameres_archive_hint")}</p>
                    </div>
                </div>
                {pickedSource && <p className="game-res-picked-hint">{strings.get("ts:gameres_local_selected", pickedSource.name)}</p>}
            </fieldset>
            <div className={classNames("drop-container", { "dropzone-active": !!dragTarget })} onDragOver={(event) => event.preventDefault()} onDragEnter={(event: DragEvent<HTMLDivElement>) => {
                if (hasOnlyFiles(event.dataTransfer)) {
                    setDragTarget(event.target);
                }
            }} onDragLeave={handleDragLeave} onDrop={(event: DragEvent<HTMLDivElement>) => {
                event.preventDefault();
                setDragTarget(null);
                if (hasOnlyFiles(event.dataTransfer)) {
                    void handleDropSource(event.dataTransfer);
                }
            }}>
                <p className="drop-figures" aria-hidden="true">
                    <img src="res/img/drag-archive.png" width="98" height="133" alt=""/>
                    {strings.get("ts:gameres_or")}
                    <img src="res/img/drag-folder.png" width="99" height="153" alt=""/>
                </p>
                <p className="desc">{strings.get("ts:gameres_drop_desc")}</p>
                <p className="archive-formats"><em>{strings.get("ts:gameres_supported_archive_formats")}</em></p>
            </div>
        </>);
        return (<div ref={wizardRef} className={classNames("game-res-wizard game-res-local", { "game-res-wizard-win98": visualStyle === 'win98' })}>
            {visualStyle === 'win98'
                ? renderWin98BannerChrome(strings.get("ts:gameres_local_title"), strings.get("ts:gameres_local_intro"), content)
                : (<>{renderCloseButton()}{renderHeader(strings.get("ts:gameres_local_title"), strings.get("ts:gameres_local_intro"))}{content}</>)}
            <footer className="game-res-wizard-actions">
                <button type="button" className="dialog-button game-res-secondary" onClick={() => setStep('choices')}>
                    {strings.get("ts:gameres_back")}
                </button>
                <button type="button" className="dialog-button game-res-primary" disabled={!pickedSource} onClick={handleProceedFromLocal}>
                    {strings.get("ts:gameres_next")}
                </button>
                {renderCancelButton()}
            </footer>
        </div>);
    }

    const content = (<>
        <div className="game-res-download-form">
            <fieldset className="game-res-source-group">
                <legend>{strings.get("ts:gameres_download_url")}</legend>
                <label className="game-res-url-label" htmlFor="archiveUrlInput">{strings.get("ts:gameres_download_url")}</label>
                <input id="archiveUrlInput" className={classNames({ invalid: !!urlError })} type="url" ref={urlInputRef} value={archiveUrl} onChange={(event) => {
            setArchiveUrl(event.currentTarget.value);
            setUrlError(undefined);
        }} onKeyDown={(event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void submitArchiveUrl();
            }
        }} placeholder="https://" aria-invalid={!!urlError} aria-describedby="archiveUrlHelp archiveUrlError"/>
                <p id="archiveUrlHelp" className="game-res-field-help">{strings.get("ts:gameres_download_url_hint")}</p>
                {urlError && <p id="archiveUrlError" className="game-res-field-error" role="alert">{urlError}</p>}
            </fieldset>
            <div className="game-res-download-context">
                <p>{strings.get("ts:gameres_download_desc")}</p>
                <p>{strings.get("ts:gameres_download_hint")}</p>
            </div>
        </div>
    </>);
    return (<div ref={wizardRef} className={classNames("game-res-wizard game-res-download", { "game-res-wizard-win98": visualStyle === 'win98' })}>
        {visualStyle === 'win98'
            ? renderWin98BannerChrome(strings.get("ts:gameres_download_title"), strings.get("ts:gameres_download_intro"), content)
            : (<>{renderCloseButton()}{renderHeader(strings.get("ts:gameres_download_title"), strings.get("ts:gameres_download_intro"))}{content}</>)}
        <footer className="game-res-wizard-actions">
            <button type="button" className="dialog-button game-res-secondary" onClick={() => setStep('choices')} disabled={isSubmitting}>
                {strings.get("ts:gameres_back")}
            </button>
            <button type="button" className="dialog-button game-res-primary" disabled={!archiveUrl.trim() || isSubmitting} onClick={() => void submitArchiveUrl()}>
                {isSubmitting ? strings.get("ts:import_preparing_for_import") : strings.get("ts:gameres_download_button")}
            </button>
            {renderCancelButton()}
        </footer>
    </div>);
};