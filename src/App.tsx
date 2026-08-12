// ============================================================
//  App.tsx
//  Root React component — layout + UI chrome.
// ============================================================

import { useEffect, useRef } from "react";
import { useFingerFrame } from "./useFingerFrame";
import { useAIStyles } from "./hooks/useAIStyles";
import { StyleDropZone } from "./components/StyleDropZone";
import "./App.css";

export default function App() {
    const {
        videoRef,
        canvasRef,
        status,
        errorMessage,
        activeStyle,
        setActiveStyle,
        showHint,
        retryCamera,
    } = useFingerFrame();

    const { styles, addCustomStyle } = useAIStyles();

    // ── Keyboard shortcuts ─────────────────────────────────────
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            const num = parseInt(e.key, 10);
            if (!isNaN(num)) {
                const idx = num === 0 ? 9 : num - 1;
                if (idx >= 0 && idx < styles.length) setActiveStyle(styles[idx].id);
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [setActiveStyle, styles]);

    const activeStyleDef = styles.find((s) => s.id === activeStyle) || styles[0];
    const hintRef = useRef<HTMLDivElement>(null);

    // saveKey is no longer needed

    return (
        <main className="app">
            {/* ═══ Loading / Error overlay ════════════════════ */}
            {status !== "ready" && (
                <div className="overlay" aria-live="polite">
                    {status === "error" ? (
                        <>
                            <div className="overlay__icon">⚠️</div>
                            <p className="overlay__title">Could not start</p>
                            <p className="overlay__message">{errorMessage}</p>
                            <div style={{display: 'flex', gap: '10px'}}>
                                <button className="overlay__reload" onClick={retryCamera}>
                                    Retry Camera
                                </button>
                                <button className="overlay__reload" onClick={() => window.location.reload()}>
                                    Reload App
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="spinner" aria-label="Loading" />
                            <p className="overlay__message">
                                {status === "idle" && "Initialising…"}
                                {status === "loading-tracker" && "Loading hand tracker…"}
                                {status === "requesting-camera" && "Requesting camera…"}
                            </p>
                        </>
                    )}
                </div>
            )}

            {/* Settings Modal Removed (Backend Proxy in use) */}

            {/* ═══ Stage ═══════════════════════════════════════ */}
            <div className="stage">
                <video
                    ref={videoRef}
                    className="stage__video"
                    autoPlay
                    playsInline
                    muted
                    aria-hidden="true"
                />
                <canvas ref={canvasRef} className="stage__canvas" />

                {/* ── Live pill ── */}
                {status === "ready" && (
                    <div className="live-pill" aria-label="Live camera active">
                        <span className="live-pill__dot" />
                        <span className="live-pill__text">LIVE</span>
                    </div>
                )}



                {/* ── Style badge ── */}
                {status === "ready" && (
                    <div
                        key={activeStyle}
                        className="style-badge"
                        style={{ "--accent": activeStyleDef.accentColor } as React.CSSProperties}
                    >
                        <span className="style-badge__label">{activeStyleDef.label}</span>
                        <span className="style-badge__desc">
                            🤖 Real AI · {activeStyleDef.label}
                        </span>
                    </div>
                )}

                {status === "ready" && (
                    <StyleDropZone onStyleCreated={(newStyle) => {
                        addCustomStyle(newStyle);
                        setActiveStyle(newStyle.id);
                    }} />
                )}

                {/* ── Gesture hint ── */}
                <div
                    ref={hintRef}
                    className={`hint${showHint && status === "ready" ? " hint--visible" : ""}`}
                    aria-hidden="true"
                >
                    <div className="hint__hands">
                        <span className="hint__hand hint__hand--left">🤙</span>
                        <span className="hint__hand hint__hand--right">🤙</span>
                    </div>
                    <p className="hint__text">
                        Frame your shot — both hands up, thumbs &amp; index fingers out
                    </p>
                </div>
            </div>

            {/* ═══ Bottom toolbar ══════════════════════════════ */}
            <nav className="toolbar" aria-label="Effect styles">
                {styles.map((style) => (
                    <button
                        key={style.id}
                        id={`style-btn-${style.id}`}
                        className={`toolbar__btn${activeStyle === style.id ? " toolbar__btn--active" : ""}`}
                        style={{ "--accent": style.accentColor } as React.CSSProperties}
                        onClick={() => setActiveStyle(style.id)}
                        title={style.description}
                        aria-pressed={activeStyle === style.id}
                    >
                        <span className="toolbar__btn-key">{style.shortcut}</span>
                        <span className="toolbar__btn-label">{style.label}</span>
                        {activeStyle === style.id && (
                            <span className="toolbar__btn-dot" style={{ background: style.accentColor }} />
                        )}
                    </button>
                ))}
            </nav>
        </main>
    );
}