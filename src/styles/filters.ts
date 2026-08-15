// ============================================================
//  filters.ts
//  Real-time local visual filter pipeline.
//
//  Priority:
//   1. GPU WebGL shaders (glFilters.ts) — real pixel-level art transforms
//   2. CSS filter + composite (fallback for devices without WebGL)
//
//  The WebGL path is tried first. If it succeeds (returns true),
//  we skip the CSS path entirely. If WebGL is not available or
//  the shader isn't loaded yet, we run the CSS pipeline below.
// ============================================================

import { processCyberpunkFilterCPU } from "../rendering/cyberpunkFilterCPU";
import type { StyleId } from "./effects";
import { applyGLFilter } from "./glFilters";
// (Removed duplicate processCyberpunkFilterCPU import)
import { processAnimeFilterCPU } from "../rendering/animeFilterCPU";

// ── Two persistent offscreen canvases (never destroyed, reused every frame) ──
let offA: HTMLCanvasElement | null = null;
let ctxA: CanvasRenderingContext2D | null = null;
let offB: HTMLCanvasElement | null = null;
let ctxB: CanvasRenderingContext2D | null = null;

function ensureOffscreen(w: number, h: number) {
    if (!offA) {
        offA = document.createElement("canvas");
        ctxA = offA.getContext("2d", { willReadFrequently: true })!;
    }
    if (!offB) {
        offB = document.createElement("canvas");
        ctxB = offB.getContext("2d")!;
    }
    if (offA.width !== w || offA.height !== h) { offA.width = w; offA.height = h; }
    if (offB.width !== w || offB.height !== h) { offB.width = w; offB.height = h; }
    return { offA: offA!, ctxA: ctxA!, offB: offB!, ctxB: ctxB! };
}

// ── Core helper: draw mirrored live webcam with a CSS filter ──────────────────
function drawLive(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    w: number,
    h: number,
    filter: string = "none"
) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.filter = filter;
    ctx.drawImage(video, 0, 0, w, h);
    ctx.filter = "none";
    ctx.restore();
}

// ── Colour overlay helper ─────────────────────────────────────────────────────
function colorWash(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    color: string,
    op: GlobalCompositeOperation = "overlay"
) {
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

// ── Gradient overlay helper ───────────────────────────────────────────────────
function gradientWash(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    top: string,
    bottom: string,
    op: GlobalCompositeOperation = "overlay"
) {
    ctx.save();
    ctx.globalCompositeOperation = op;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

// ── Debug mode flag — set window.__FFDebug = true in console to enable ─────────
declare global { interface Window { __FFDebug?: boolean; } }

// ═══════════════════════════════════════════════════════════════════════════════
//  applyLocalFilter — called EVERY FRAME inside the finger-frame polygon
// ═══════════════════════════════════════════════════════════════════════════════
export function getFilteredCanvas(
    video: HTMLVideoElement,
    w: number,
    h: number,
    style: StyleId,
    time: number,
    filterImage: HTMLImageElement | null
): HTMLCanvasElement {
    const dbg = typeof window !== "undefined" && window.__FFDebug;

    const { offA, ctxA, offB, ctxB } = ensureOffscreen(w, h);
    
    // We will use offA as the final result canvas for CPU path and static assets.
    // Ensure it starts clean
    ctxA.clearRect(0, 0, w, h);

    // ── Static asset fast path (pre-rendered filter PNG) ──────────────────────
    if (filterImage && filterImage.complete && filterImage.naturalWidth > 0) {
        // Draw video base
        drawLive(ctxA, video, w, h, "none");
        ctxA.drawImage(filterImage, 0, 0, w, h);
        if (dbg) console.log(`[Composite] Static asset rendered to filter canvas`);
        return offA;
    }

    // ── GPU path: WebGL shader ────────────────────────────────────────────
    const glCanvas = applyGLFilter(video, w, h, style, time);
    if (glCanvas) {
        if (dbg) console.log(`[Composite] GL shader rendered to filter canvas`);
        return glCanvas;
    }

    // ── CPU fallback: Canvas2D composite filters ───────────────────────────
    // These run every frame as an immediate fallback while the FLUX AI
    // result is loading asynchronously. Each one is designed to be
    // visually distinctive and clearly recognizable as the intended style.
    switch (style as string) {

        // ── CINEMATIC: Warm film-grade look ───────────────────────────────
        case "cinematic": {
            // Base: slightly warm + refined
            drawLive(ctxA, video, w, h, "saturate(1.3) contrast(1.15) brightness(1.08)");
            // Warm amber grade — upper half
            const cgTop = ctxA.createLinearGradient(0, 0, 0, h);
            cgTop.addColorStop(0,   "rgba(255,210,140,0.22)");
            cgTop.addColorStop(0.5, "rgba(255,210,140,0.08)");
            cgTop.addColorStop(1,   "rgba(20,10,60,0.30)");
            ctxA.save();
            ctxA.globalCompositeOperation = "overlay";
            ctxA.fillStyle = cgTop;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            // Subtle vignette
            const vig = ctxA.createRadialGradient(w/2, h/2, h*0.3, w/2, h/2, h*0.9);
            vig.addColorStop(0, "rgba(0,0,0,0)");
            vig.addColorStop(1, "rgba(0,0,0,0.45)");
            ctxA.save();
            ctxA.globalCompositeOperation = "multiply";
            ctxA.fillStyle = vig;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            break;
        }

        // ── EDITORIAL INK: High-contrast pencil sketch ────────────────────
        case "editorial-ink": {
            ctxB.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "grayscale(100%) brightness(1.2) contrast(1.1)");
            drawLive(ctxB, video, w, h, "grayscale(100%) invert(100%) blur(6px)");
            ctxA.save();
            ctxA.globalCompositeOperation = "color-dodge";
            ctxA.drawImage(offB, 0, 0);
            ctxA.restore();
            // Warm paper tint
            colorWash(ctxA, w, h, "rgba(232,220,195,0.65)", "multiply");
            // Darken shadows
            ctxA.save();
            ctxA.globalCompositeOperation = "multiply";
            ctxA.fillStyle = "rgba(80,60,40,0.15)";
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            break;
        }

        // ── WATERCOLOR: Multi-pass painted effect ─────────────────────────
        case "watercolor": {
            ctxB.clearRect(0, 0, w, h);
            // Soft blurred base (paint bleeding)
            drawLive(ctxA, video, w, h, "saturate(1.6) contrast(1.05) brightness(1.15) blur(5px)");
            // Sharp detail layer
            drawLive(ctxB, video, w, h, "saturate(1.8) contrast(1.5) brightness(1.0)");
            // Blend: mostly blurred, small sharp overlay for detail
            ctxA.save();
            ctxA.globalAlpha = 0.25;
            ctxA.globalCompositeOperation = "source-over";
            ctxA.drawImage(offB, 0, 0);
            ctxA.restore();
            // Warm paper / pigment tint
            colorWash(ctxA, w, h, "rgba(245,225,195,0.55)", "multiply");
            colorWash(ctxA, w, h, "rgba(200,170,220,0.15)", "overlay");
            colorWash(ctxA, w, h, "rgba(255,200,160,0.12)", "screen");
            break;
        }

        // ── FILM NOIR: High-contrast monochrome ───────────────────────────
        case "film-noir": {
            drawLive(ctxA, video, w, h, "grayscale(100%) contrast(1.7) brightness(0.88)");
            // Deep shadow vignette
            const nvg = ctxA.createRadialGradient(w/2, h/2, h*0.2, w/2, h/2, h*0.85);
            nvg.addColorStop(0, "rgba(0,0,0,0)");
            nvg.addColorStop(1, "rgba(0,0,0,0.60)");
            ctxA.save();
            ctxA.globalCompositeOperation = "multiply";
            ctxA.fillStyle = nvg;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            break;
        }

        // ── GRAPHITE: Pencil drawing ──────────────────────────────────────
        case "graphite": {
            ctxB.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "grayscale(100%) brightness(1.2)");
            drawLive(ctxB, video, w, h, "grayscale(100%) invert(100%) blur(6px)");
            ctxA.save();
            ctxA.globalCompositeOperation = "color-dodge";
            ctxA.drawImage(offB, 0, 0);
            ctxA.restore();
            // Cool-grey paper tint
            colorWash(ctxA, w, h, "rgba(210,212,218,0.55)", "multiply");
            break;
        }

        // ── SOFT 3D / 3D Movie: Vivid animated film look ──────────────────
        case "soft-3d": {
            // Highly saturated + slightly blown out (cartoon render look)
            drawLive(ctxA, video, w, h, "saturate(2.8) contrast(1.25) brightness(1.18)");
            // Soft warm highlight glow
            const glow = ctxA.createRadialGradient(w*0.5, h*0.35, 0, w*0.5, h*0.35, w*0.65);
            glow.addColorStop(0,   "rgba(255,240,200,0.30)");
            glow.addColorStop(0.6, "rgba(255,240,200,0.05)");
            glow.addColorStop(1,   "rgba(0,0,0,0)");
            ctxA.save();
            ctxA.globalCompositeOperation = "screen";
            ctxA.fillStyle = glow;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            // Purple-blue rim light
            colorWash(ctxA, w, h, "rgba(130,70,255,0.14)", "overlay");
            colorWash(ctxA, w, h, "rgba(255,220,80,0.08)", "screen");
            break;
        }

        // ── CYBERPUNK: Neon cyan + magenta split ──────────────────────────
        case "cyber-editorial": {
            // Dark + high contrast base
            drawLive(ctxA, video, w, h, "saturate(1.2) contrast(1.4) brightness(0.82)");
            // Cyan left rim light
            const cyanRim = ctxA.createLinearGradient(0, 0, w * 0.4, 0);
            cyanRim.addColorStop(0, "rgba(0,255,230,0.35)");
            cyanRim.addColorStop(1, "rgba(0,255,230,0)");
            ctxA.save();
            ctxA.globalCompositeOperation = "screen";
            ctxA.fillStyle = cyanRim;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            // Magenta right rim light
            const magRim = ctxA.createLinearGradient(w, 0, w * 0.6, 0);
            magRim.addColorStop(0, "rgba(255,0,180,0.30)");
            magRim.addColorStop(1, "rgba(255,0,180,0)");
            ctxA.save();
            ctxA.globalCompositeOperation = "screen";
            ctxA.fillStyle = magRim;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            // Atmospheric blue-dark overlay
            colorWash(ctxA, w, h, "rgba(0,20,60,0.28)", "multiply");
            break;
        }

        // ── VINTAGE FILM: Warm amber ──────────────────────────────────────
        case "vintage-film": {
            drawLive(ctxA, video, w, h, "saturate(1.9) contrast(1.35) brightness(1.05) blur(0.8px)");
            colorWash(ctxA, w, h, "rgba(210,140,50,0.25)", "overlay");
            colorWash(ctxA, w, h, "rgba(255,220,130,0.10)", "screen");
            // Faded corners
            const vvg = ctxA.createRadialGradient(w/2, h/2, h*0.3, w/2, h/2, h*0.9);
            vvg.addColorStop(0, "rgba(0,0,0,0)");
            vvg.addColorStop(1, "rgba(40,20,0,0.50)");
            ctxA.save();
            ctxA.globalCompositeOperation = "multiply";
            ctxA.fillStyle = vvg;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            break;
        }

        // ── ANIME: Vivid cel-shade look ───────────────────────────────────
        case "anime": {
            // High contrast + flat colours
            drawLive(ctxA, video, w, h, "saturate(2.5) contrast(1.55) brightness(1.10)");
            // Warm pastel skin wash
            colorWash(ctxA, w, h, "rgba(255,210,180,0.18)", "overlay");
            // Slight blue sky top
            const animeTint = ctxA.createLinearGradient(0, 0, 0, h * 0.4);
            animeTint.addColorStop(0, "rgba(140,200,255,0.15)");
            animeTint.addColorStop(1, "rgba(140,200,255,0)");
            ctxA.save();
            ctxA.globalCompositeOperation = "screen";
            ctxA.fillStyle = animeTint;
            ctxA.fillRect(0, 0, w * 2, h * 0.4);
            ctxA.restore();
            break;
        }

        // ── Legacy + fallback IDs ─────────────────────────────────────────
        case "cyberpunk":
        case "cyberpunk-girl": {
            processCyberpunkFilterCPU(video, ctxA, w, h, time, style === "cyberpunk-girl");
            break;
        }
        case "sketch": {
            ctxB.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "grayscale(100%) brightness(1.2)");
            drawLive(ctxB, video, w, h, "grayscale(100%) invert(100%) blur(5px)");
            ctxA.save();
            ctxA.globalCompositeOperation = "color-dodge";
            ctxA.drawImage(offB, 0, 0);
            ctxA.restore();
            colorWash(ctxA, w, h, "rgba(232,222,200,0.60)", "multiply");
            break;
        }
        case "oil-painting": {
            drawLive(ctxA, video, w, h, "saturate(2.2) contrast(1.45) brightness(1.05) blur(2px)");
            colorWash(ctxA, w, h, "rgba(190,120,50,0.25)", "overlay");
            break;
        }
        case "hand-drawn-anime": {
            drawLive(ctxA, video, w, h, "saturate(2.0) contrast(1.4) brightness(1.08)");
            colorWash(ctxA, w, h, "rgba(255,215,180,0.20)", "overlay");
            colorWash(ctxA, w, h, "rgba(245,235,220,0.35)", "multiply");
            break;
        }
        case "movie3d":
        case "pixar": {
            drawLive(ctxA, video, w, h, "saturate(2.8) contrast(1.25) brightness(1.18)");
            colorWash(ctxA, w, h, "rgba(130,70,255,0.14)", "overlay");
            colorWash(ctxA, w, h, "rgba(255,220,80,0.08)", "screen");
            break;
        }
        case "portrait": {
            drawLive(ctxA, video, w, h, "saturate(1.35) contrast(1.12) brightness(1.08)");
            const pgTop = ctxA.createLinearGradient(0, 0, 0, h);
            pgTop.addColorStop(0,   "rgba(255,210,140,0.20)");
            pgTop.addColorStop(0.5, "rgba(255,210,140,0.06)");
            pgTop.addColorStop(1,   "rgba(20,10,60,0.28)");
            ctxA.save();
            ctxA.globalCompositeOperation = "overlay";
            ctxA.fillStyle = pgTop;
            ctxA.fillRect(0, 0, w, h);
            ctxA.restore();
            break;
        }
        default: {
            // Safe fallback — always visually distinct from plain webcam
            drawLive(ctxA, video, w, h, "saturate(1.9) contrast(1.28) brightness(1.05)");
            colorWash(ctxA, w, h, "rgba(200,140,80,0.20)", "overlay");
            break;
        }
    }

    return offA;
}
