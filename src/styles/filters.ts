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

import { processCyberpunkFilterCPU, processOilPaintingFilterCPU, process3DAnimeFilterCPU } from "../rendering/cyberpunkFilterCPU";
import type { StyleId } from "./effects";
import { applyGLFilter } from "./glFilters";
// (Removed duplicate processCyberpunkFilterCPU import)


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
// @ts-ignore
function _gradientWash(
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
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Point } from "../rendering/fingerFrameRenderer";

export function getFilteredCanvas(
    video: HTMLVideoElement,
    w: number,
    h: number,
    style: StyleId,
    time: number,
    filterImage: HTMLImageElement | null,
    polygonMask?: Point[] | null,
    faceResult?: FaceLandmarkerResult | null
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
            // GL shader flips UV internally so its pixels are mirrored.
            // But we must return a canvas that gets drawn by `drawImage(filterCanvas, 0, 0, w, h)`
            // onto the main canvas. The main canvas draws the *base* video mirrored, and the
            // quad coordinates are mirrored. So we actually want to draw the GL canvas UN-mirrored
            // onto offA so that it visually matches what the main canvas expects.
            // Wait, the GL shader ALREADY mirrored the texture (v_uv.x = 1.0 - a_uv.x).
            // So if we just return glCanvas, it draws its mirrored pixels onto the main canvas
            // which has NO TRANSFORM active during the clip/draw phase. This causes the mirrored
            // pixels to appear mirrored. We need to flip it back, OR we can just flip the GL canvas
            // when we draw it into offA, and return offA.
            ctxA.save();
            ctxA.drawImage(glCanvas, 0, 0, w, h);
            ctxA.restore();
            return offA;
        }

    // ── CPU fallback: Canvas2D composite filters ───────────────────────────
    // These run every frame as an immediate fallback while the FLUX AI
    // result is loading asynchronously. Each one is designed to be
    // visually distinctive and clearly recognizable as the intended style.
    switch (style as string) {

        case "oil-painting": {
            processOilPaintingFilterCPU(video, ctxA, w, h, polygonMask);
            break;
        }

        case "cyberpunk": {
            processCyberpunkFilterCPU(video, ctxA, w, h, time, false, polygonMask, faceResult);
            break;
        }

        case "3d-anime": {
            process3DAnimeFilterCPU(video, ctxA, w, h, polygonMask);
            break;
        }

        case "hand-drawn-anime": {
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

        case "watercolor": {
            ctxB.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "saturate(1.6) contrast(1.05) brightness(1.15) blur(5px)");
            drawLive(ctxB, video, w, h, "saturate(1.8) contrast(1.5) brightness(1.0)");
            ctxA.save();
            ctxA.globalAlpha = 0.25;
            ctxA.globalCompositeOperation = "source-over";
            ctxA.drawImage(offB, 0, 0);
            ctxA.restore();
            colorWash(ctxA, w, h, "rgba(245,225,195,0.55)", "multiply");
            colorWash(ctxA, w, h, "rgba(200,170,220,0.15)", "overlay");
            colorWash(ctxA, w, h, "rgba(255,200,160,0.12)", "screen");
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
