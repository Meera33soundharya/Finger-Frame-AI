import { useState, useCallback, useRef } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import { analyzeImageStyle } from '../ai/styleAnalyzer';
import type { StyleDef } from '../styles/effects';
import './StyleDropZone.css';

interface StyleDropZoneProps {
    onStyleCreated: (style: StyleDef) => void;
}

type ZoneState = 'idle' | 'dragging' | 'analyzing' | 'done' | 'error';

export function StyleDropZone({ onStyleCreated }: StyleDropZoneProps) {
    const [zoneState,   setZoneState]   = useState<ZoneState>('idle');
    const [thumbnail,   setThumbnail]   = useState<string | null>(null);
    const [palette,     setPalette]     = useState<string[]>([]);
    const [accent,      setAccent]      = useState<string>('#a855f7');
    const [errorMsg,    setErrorMsg]    = useState('');
    const [progress,    setProgress]    = useState(0);
    const fileRef = useRef<HTMLInputElement>(null);

    const processFile = useCallback(async (file: File) => {
        if (!file.type.startsWith('image/')) {
            setErrorMsg('Please drop an image file');
            setZoneState('error');
            return;
        }

        // Show thumbnail immediately
        const thumbUrl = URL.createObjectURL(file);
        setThumbnail(thumbUrl);
        setZoneState('analyzing');
        setProgress(0);
        setErrorMsg('');

        // Animate progress bar while analyzing
        const startMs = Date.now();
        const progressInterval = setInterval(() => {
            const elapsed = Date.now() - startMs;
            setProgress(Math.min(0.9, elapsed / 800));
        }, 40);

        try {
            const newStyle = await analyzeImageStyle(file);
            clearInterval(progressInterval);
            setProgress(1);

            if ('palette' in newStyle && newStyle.palette) {
                setPalette(newStyle.palette.colors ?? []);
                setAccent(newStyle.palette.accentColor ?? '#a855f7');
            }

            setZoneState('done');
            onStyleCreated(newStyle);

            // Reset after 2.5s
            setTimeout(() => {
                setZoneState('idle');
                URL.revokeObjectURL(thumbUrl);
                setThumbnail(null);
                setPalette([]);
                setProgress(0);
            }, 2500);
        } catch (err) {
            clearInterval(progressInterval);
            setErrorMsg(err instanceof Error ? err.message : 'Analysis failed');
            setZoneState('error');
        }
    }, [onStyleCreated]);

    const onDragOver  = useCallback((e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setZoneState('dragging'); }, []);
    const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setZoneState('idle'); }, []);
    const onDrop      = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) processFile(e.dataTransfer.files[0]);
        else setZoneState('idle');
    }, [processFile]);

    const onFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) processFile(e.target.files[0]);
        e.target.value = '';
    }, [processFile]);

    const onClick = useCallback(() => {
        if (zoneState === 'idle' || zoneState === 'error') fileRef.current?.click();
    }, [zoneState]);

    const zoneClass = [
        'dropzone',
        zoneState === 'dragging'  ? 'dropzone--dragging'  : '',
        zoneState === 'analyzing' ? 'dropzone--analyzing' : '',
        zoneState === 'done'      ? 'dropzone--done'      : '',
        zoneState === 'error'     ? 'dropzone--error'     : '',
    ].filter(Boolean).join(' ');

    return (
        <div
            className={zoneClass}
            style={{ '--dz-accent': accent } as React.CSSProperties}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={onClick}
            role="button"
            tabIndex={0}
            aria-label="Drop an image to create a custom style"
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
        >
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="dropzone__file-input"
                onChange={onFileChange}
                aria-hidden="true"
            />

            {/* Thumbnail */}
            {thumbnail && (
                <img src={thumbnail} alt="Style preview" className="dropzone__thumbnail" />
            )}

            {/* Progress ring */}
            {zoneState === 'analyzing' && (
                <svg className="dropzone__progress-ring" viewBox="0 0 36 36" aria-hidden="true">
                    <circle
                        className="dropzone__progress-track"
                        cx="18" cy="18" r="15.9"
                        fill="none" strokeWidth="2.5"
                    />
                    <circle
                        className="dropzone__progress-fill"
                        cx="18" cy="18" r="15.9"
                        fill="none" strokeWidth="2.5"
                        strokeDasharray={`${progress * 100} 100`}
                        style={{ stroke: accent }}
                    />
                </svg>
            )}

            {/* Status text */}
            <div className="dropzone__content">
                {zoneState === 'idle' && (
                    <>
                        <span className="dropzone__icon">🎨</span>
                        <span className="dropzone__label">Drop image</span>
                        <span className="dropzone__hint">to create AI style</span>
                    </>
                )}
                {zoneState === 'dragging' && (
                    <>
                        <span className="dropzone__icon dropzone__icon--bounce">✨</span>
                        <span className="dropzone__label">Release to analyze</span>
                    </>
                )}
                {zoneState === 'analyzing' && (
                    <>
                        <span className="dropzone__label">Analyzing…</span>
                        <span className="dropzone__hint">{Math.round(progress * 100)}%</span>
                    </>
                )}
                {zoneState === 'done' && (
                    <>
                        <span className="dropzone__icon">✅</span>
                        <span className="dropzone__label">Style added!</span>
                    </>
                )}
                {zoneState === 'error' && (
                    <>
                        <span className="dropzone__icon">⚠️</span>
                        <span className="dropzone__label">Failed</span>
                        <span className="dropzone__hint">{errorMsg}</span>
                    </>
                )}
            </div>

            {/* Colour palette swatches */}
            {palette.length > 0 && (
                <div className="dropzone__palette" aria-label="Extracted colour palette">
                    {palette.map((hex, i) => (
                        <span
                            key={i}
                            className="dropzone__swatch"
                            style={{ background: hex }}
                            title={hex}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
