// ============================================================
//  App.tsx
//  Root React component — layout + UI chrome.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { useFingerFrame } from "./useFingerFrame";
import { useAIStyles } from "./hooks/useAIStyles";
import { StyleDropZone } from "./components/StyleDropZone";
import { FAL_KEY_STORAGE } from "./ai/modelBackend";
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
        fingerStates,
        gesture,
    } = useFingerFrame();

    const { styles, addCustomStyle } = useAIStyles();
    const [showSettings, setShowSettings] = useState(false);
    const [apiKey, setApiKey] = useState(() => localStorage.getItem(FAL_KEY_STORAGE) ?? "");
    const [keySaved, setKeySaved] = useState(!!localStorage.getItem(FAL_KEY_STORAGE));

    // Keep keySaved in sync with localStorage (e.g. when backend auto-clears key on 403)
    useEffect(() => {
        function syncKey() {
            const saved = !!localStorage.getItem(FAL_KEY_STORAGE);
            setKeySaved(saved);
            if (!saved) setApiKey("");
        }
        // Poll every 2s for key removal by the backend (no cross-window storage event needed)
        const interval = setInterval(syncKey, 2000);
        window.addEventListener("storage", syncKey);
        return () => {
            clearInterval(interval);
            window.removeEventListener("storage", syncKey);
        };
    }, []);

    // ── Keyboard shortcuts ─────────────────────────────────────
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") { setShowSettings(false); return; }
            if (e.key === ",") { setShowSettings(v => !v); return; }
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

    function saveKey() {
        const trimmed = apiKey.trim();
        if (trimmed) {
            localStorage.setItem(FAL_KEY_STORAGE, trimmed);
        } else {
            localStorage.removeItem(FAL_KEY_STORAGE);
        }
        setKeySaved(!!trimmed);
        setShowSettings(false);
        // Reload to re-init backend with new key
        window.location.reload();
    }

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
                            <button className="overlay__reload" onClick={() => window.location.reload()}>
                                Reload
                            </button>
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

            {/* ═══ Settings Modal ══════════════════════════════ */}
            {showSettings && (
                <div className="settings-overlay" onClick={() => setShowSettings(false)}>
                    <div className="settings-modal" onClick={e => e.stopPropagation()}>
                        <div className="settings-modal__header">
                            <h2 className="settings-modal__title">⚙️ Settings</h2>
                            <button className="settings-modal__close" onClick={() => setShowSettings(false)}>✕</button>
                        </div>

                        <div className="settings-modal__section">
                            <label className="settings-modal__label" htmlFor="fal-key-input">
                                🔑 Fal.ai API Key
                            </label>
                            <p className="settings-modal__hint">
                                Get your free key at <a href="https://fal.ai/keys" target="_blank" rel="noopener noreferrer">fal.ai/keys</a>.<br />
                                Without a key, a high-quality <b>mock filter</b> is used instead.
                            </p>
                            <input
                                id="fal-key-input"
                                className="settings-modal__input"
                                type="password"
                                value={apiKey}
                                onChange={e => setApiKey(e.target.value)}
                                placeholder="fal_…"
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <div className="settings-modal__status">
                                {keySaved
                                    ? <span className="settings-modal__status--ok">✅ Fal.ai connected — real AI inference active</span>
                                    : <span className="settings-modal__status--warn">⚠️ No key saved — using mock filter</span>
                                }
                            </div>
                        </div>

                        <div className="settings-modal__actions">
                            <button className="settings-modal__save" onClick={saveKey}>
                                Save &amp; Reload
                            </button>
                            <button className="settings-modal__cancel" onClick={() => setShowSettings(false)}>
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

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

                {/* ── Finger Count & Gesture Display ── */}
                {status === "ready" && fingerStates && (
                    <div className="finger-stats" style={{
                        position: "absolute",
                        top: "80px",
                        right: "20px",
                        background: "rgba(0, 0, 0, 0.7)",
                        color: "#fff",
                        padding: "12px 16px",
                        borderRadius: "8px",
                        fontFamily: "monospace",
                        fontSize: "14px",
                        zIndex: 10,
                        textAlign: "center",
                        minWidth: "140px",
                    }}>
                        <div style={{ fontWeight: "bold", marginBottom: "8px", fontSize: "16px" }}>
                            🖐️ Fingers: {fingerStates.count}
                        </div>
                        <div style={{ fontSize: "12px", opacity: 0.8 }}>
                            {fingerStates.thumb && "👍"} 
                            {fingerStates.index && "☝️"} 
                            {fingerStates.middle && "🖕"} 
                            {fingerStates.ring && "💍"} 
                            {fingerStates.pinky && "🤙"}
                        </div>
                        {gesture && (
                            <div style={{ marginTop: "8px", fontSize: "13px", color: "#4ade80" }}>
                                ✨ {gesture.toUpperCase()}
                            </div>
                        )}
                    </div>
                )}

                {/* ── Settings button ── */}
                {status === "ready" && (
                    <button
                        id="settings-btn"
                        className={`settings-btn${keySaved ? " settings-btn--connected" : " settings-btn--attention"}`}
                        onClick={() => {
                            // Re-sync from localStorage in case backend auto-cleared the key
                            const currentKey = localStorage.getItem(FAL_KEY_STORAGE) ?? "";
                            setApiKey(currentKey);
                            setKeySaved(!!currentKey);
                            setShowSettings(true);
                        }}
                        title="Settings (press ,)"
                        aria-label="Open settings"
                    >
                        <span className="settings-btn__icon">⚙️</span>
                        {keySaved
                            ? <span className="settings-btn__label">AI Connected</span>
                            : <span className="settings-btn__label">Add API Key</span>
                        }
                    </button>
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
                            {keySaved ? "🤖 Real AI" : "🎨 Mock"} · {activeStyleDef.label}
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