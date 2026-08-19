import React, { useState, useRef, useEffect, useCallback, DragEvent, FormEvent } from 'react';
import classNames from 'classnames';
import type { Strings } from '../../data/Strings';

type SetupStep = 'welcome' | 'local' | 'download';
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
    onBrowseFolder: () => Promise<void> | void;
    onBrowseArchive: () => Promise<void> | void;
    onDrop: (dataTransfer: DataTransfer) => Promise<void> | void;
    onClose?: () => void;
}
export const GameResForm: React.FC<GameResFormProps> = ({ closable, strings, defaultArchiveUrl, visualStyle = 'ra2', installProgress, onDownloadArchive, onBrowseFolder, onBrowseArchive, onDrop, onClose, }) => {
    const [dragTarget, setDragTarget] = useState<EventTarget | null | undefined>(null);
    const [step, setStep] = useState<SetupStep>('welcome');
    const [sourceRoute, setSourceRoute] = useState<SourceRoute | null>(null);
    const [archiveUrl, setArchiveUrl] = useState<string>(defaultArchiveUrl || '');
    const [urlError, setUrlError] = useState<string>();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const routeInputRef = useRef<HTMLInputElement>(null);
    const urlInputRef = useRef<HTMLInputElement>(null);

    const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (event.target === dragTarget) {
            setDragTarget(null);
        }
    }, [dragTarget]);

    useEffect(() => {
        if (step === 'welcome') {
            routeInputRef.current?.focus();
        }
        else if (step === 'download') {
            urlInputRef.current?.focus();
        }
    }, [step]);

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

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
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

    const renderCancelButton = () => closable ? (<button type="button" className="dialog-button game-res-secondary" onClick={onClose}>
        {strings.get("ts:gameres_cancel")}
    </button>) : null;

    const renderHeader = (stepLabel: string, title: string, description: string) => (<header className="game-res-wizard-header">
        <div className="game-res-wizard-heading">
            <div className="game-res-wizard-step">{stepLabel}</div>
            <h2>{title}</h2>
            <p>{description}</p>
        </div>
        {visualStyle === 'win98' && <span className="game-res-wizard-page-icon" aria-hidden="true"/>}
    </header>);

    const renderCloseButton = () => closable ? (<button type="button" className="close-button" onClick={onClose} aria-label="Close"/>) : null;

    const renderWindowTitle = (showClose: boolean = true) => (<div className="game-res-window-titlebar">
        <span>{strings.get("ts:gameres_setup_window_title")}</span>
        {showClose && renderCloseButton()}
    </div>);

    if (installProgress) {
        const percent = installProgress.percent;
        return (<div className={classNames("game-res-wizard game-res-installing", { "game-res-wizard-win98": visualStyle === 'win98' })}>
            {visualStyle === 'win98' ? renderWindowTitle(false) : null}
            {renderHeader(strings.get("ts:gameres_setup_step_three"), strings.get("ts:gameres_installing_title"), strings.get("ts:gameres_installing_intro"))}
            <div className="game-res-progress-area">
                <p className="game-res-progress-text">{installProgress.text || strings.get("ts:import_preparing_for_import")}</p>
                <div className={classNames("game-res-progress-bar", { indeterminate: percent === undefined })}>
                    <div className="game-res-progress-fill" style={percent !== undefined ? { width: `${Math.min(100, Math.max(0, percent))}%` } : undefined}/>
                </div>
            </div>
        </div>);
    }

    if (step === 'welcome') {
        return (<div className={classNames("game-res-wizard game-res-welcome", { "game-res-wizard-win98": visualStyle === 'win98' })}>
            {visualStyle === 'win98' ? renderWindowTitle() : renderCloseButton()}
            {renderHeader(strings.get("ts:gameres_setup_step_one"), strings.get("ts:gameres_setup_title"), strings.get("ts:gameres_setup_intro"))}
            <fieldset className="game-res-source-group game-res-route-group">
                <legend>{strings.get("ts:gameres_setup_question")}</legend>
                <label className={classNames("game-res-route-option", { selected: sourceRoute === 'local' })}>
                    <input ref={routeInputRef} type="radio" name="gameResSource" value="local" checked={sourceRoute === 'local'} onChange={() => setSourceRoute('local')}/>
                    <span>
                        <strong>{strings.get("ts:gameres_setup_have_files")}</strong>
                        <small>{strings.get("ts:gameres_setup_have_files_hint")}</small>
                    </span>
                </label>
                <label className={classNames("game-res-route-option", { selected: sourceRoute === 'download' })}>
                    <input type="radio" name="gameResSource" value="download" checked={sourceRoute === 'download'} onChange={() => setSourceRoute('download')}/>
                    <span>
                        <strong>{strings.get("ts:gameres_setup_need_download")}</strong>
                        <small>{strings.get("ts:gameres_setup_need_download_hint")}</small>
                    </span>
                </label>
            </fieldset>
            <footer className="game-res-wizard-actions">
                {renderCancelButton()}
                <button type="button" className="dialog-button game-res-primary" disabled={!sourceRoute} onClick={() => setStep(sourceRoute || 'welcome')}>
                    {strings.get("ts:gameres_next")}
                </button>
            </footer>
        </div>);
    }

    if (step === 'local') {
        return (<div className={classNames("game-res-wizard game-res-local", { "game-res-wizard-win98": visualStyle === 'win98' })}>
            {visualStyle === 'win98' ? renderWindowTitle() : renderCloseButton()}
            {renderHeader(strings.get("ts:gameres_setup_step_two"), strings.get("ts:gameres_local_title"), strings.get("ts:gameres_local_intro"))}
            <fieldset className="game-res-source-group">
                <legend>{strings.get("ts:gameres_local_source_label")}</legend>
                <div className="game-res-source-actions">
                    <div>
                        <button type="button" className="dialog-button game-res-primary" onClick={onBrowseFolder}>
                            {strings.get("ts:gameres_browse_folder")}
                        </button>
                        <p>{strings.get("ts:gameres_folder_hint")}</p>
                    </div>
                    <div>
                        <button type="button" className="dialog-button game-res-secondary" onClick={onBrowseArchive}>
                            {strings.get("ts:gameres_browse_archive")}
                        </button>
                        <p>{strings.get("ts:gameres_archive_hint")}</p>
                    </div>
                </div>
            </fieldset>
            <div className={classNames("drop-container", { "dropzone-active": !!dragTarget })} onDragOver={(event) => event.preventDefault()} onDragEnter={(event: DragEvent<HTMLDivElement>) => {
                if (hasOnlyFiles(event.dataTransfer)) {
                    setDragTarget(event.target);
                }
            }} onDragLeave={handleDragLeave} onDrop={(event: DragEvent<HTMLDivElement>) => {
                event.preventDefault();
                setDragTarget(null);
                if (hasOnlyFiles(event.dataTransfer)) {
                    void onDrop(event.dataTransfer);
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
            {visualStyle === 'win98' ? (<p className="game-res-alt-action">
                <button type="button" className="game-res-link" onClick={() => setStep('download')}>
                    {strings.get("ts:gameres_switch_to_download")}
                </button>
            </p>) : null}
            <footer className="game-res-wizard-actions">
                <button type="button" className="dialog-button game-res-secondary" onClick={() => setStep('welcome')}>
                    {strings.get("ts:gameres_back")}
                </button>
                {visualStyle === 'win98' ? null : renderCancelButton()}
            </footer>
        </div>);
    }

    return (<div className={classNames("game-res-wizard game-res-download", { "game-res-wizard-win98": visualStyle === 'win98' })}>
        {visualStyle === 'win98' ? renderWindowTitle() : renderCloseButton()}
        {renderHeader(strings.get("ts:gameres_setup_step_two"), strings.get("ts:gameres_download_title"), strings.get("ts:gameres_download_intro"))}
        <form className="game-res-download-form" onSubmit={handleSubmit}>
            <fieldset className="game-res-source-group">
                <legend>{strings.get("ts:gameres_download_url")}</legend>
                <label className="game-res-url-label" htmlFor="archiveUrlInput">{strings.get("ts:gameres_download_url")}</label>
                <input id="archiveUrlInput" className={classNames({ invalid: !!urlError })} type="url" ref={urlInputRef} value={archiveUrl} onChange={(event) => {
            setArchiveUrl(event.currentTarget.value);
            setUrlError(undefined);
        }} placeholder="https://" aria-invalid={!!urlError} aria-describedby="archiveUrlHelp archiveUrlError"/>
                <p id="archiveUrlHelp" className="game-res-field-help">{strings.get("ts:gameres_download_url_hint")}</p>
                {urlError && <p id="archiveUrlError" className="game-res-field-error" role="alert">{urlError}</p>}
            </fieldset>
            <div className="game-res-download-context">
                <p>{strings.get("ts:gameres_download_desc")}</p>
                <p>{strings.get("ts:gameres_download_hint")}</p>
            </div>
            <footer className="game-res-wizard-actions">
                <button type="button" className="dialog-button game-res-secondary" onClick={() => setStep('welcome')} disabled={isSubmitting}>
                    {strings.get("ts:gameres_back")}
                </button>
                {renderCancelButton()}
                <button type="submit" className="dialog-button game-res-primary" disabled={!archiveUrl.trim() || isSubmitting}>
                    {isSubmitting ? strings.get("ts:import_preparing_for_import") : strings.get("ts:gameres_download_button")}
                </button>
            </footer>
        </form>
    </div>);
};
