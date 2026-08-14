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

import type { Point } from "../rendering/fingerFrameRenderer";
import type { StyleId } from "./effects";
import { applyGLFilter } from "./glFilters";
import { processCyberpunkFilterCPU } from "../rendering/cyberpunkFilterCPU";
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

// ═══════════════════════════════════════════════════════════════════════════════
//  applyLocalFilter — called EVERY FRAME inside the finger-frame polygon
// ═══════════════════════════════════════════════════════════════════════════════
export function applyLocalFilter(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    w: number,
    h: number,
    quad: Point[],
    style: StyleId,
    time: number,
    filterImage: HTMLImageElement | null
) {
    // ── Static asset fast path (e.g. pre-rendered filter PNG) ────────────────
    if (filterImage && filterImage.complete && filterImage.naturalWidth > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of quad) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
        const qW = maxX - minX;
        const qH = maxY - minY;
        const imgRatio  = filterImage.naturalWidth / filterImage.naturalHeight;
        const quadRatio = qW / qH;
        let drawW = qW, drawH = qH;
        if (imgRatio > quadRatio) drawW = qH * imgRatio;
        else                      drawH = qW / imgRatio;
        const drawX = minX + (qW - drawW) / 2;
        const drawY = minY + (qH - drawH) / 2;
        ctx.drawImage(filterImage, drawX, drawY, drawW, drawH);
        return;
    }

    // ── GPU path: WebGL shader ────────────────────────────────────────────────
    const gpuDone = applyGLFilter(ctx, video, w, h, quad, style, time);
    if (gpuDone) return;

    // ── CPU fallback: CSS composite filters ──────────────────────────────────
    const { offA, ctxA, offB, ctxB } = ensureOffscreen(w, h);

    switch (style) {

        // ── 3D MOVIE ─────────────────────────────────────────────────────────
        case "movie3d": {
            drawLive(ctx, video, w, h, "saturate(2.2) contrast(1.3) brightness(1.1)");
            colorWash(ctx, w, h, "rgba(255, 170, 50, 0.22)", "overlay");
            colorWash(ctx, w, h, "rgba(255, 200, 100, 0.08)", "screen");
            break;
        }

        // ── ANIME ─────────────────────────────────────────────────────────────
        case "anime": {
            processAnimeFilterCPU(video, ctx, w, h, time);
            break;
        }

        // ── CYBER BOY ─────────────────────────────────────────────────────────
        case "cyberpunk": {
            processCyberpunkFilterCPU(video, ctx, w, h, time, false);
            break;
        }

        // ── CYBER GIRL ────────────────────────────────────────────────────────
        case "cyberpunk-girl": {
            processCyberpunkFilterCPU(video, ctx, w, h, time, true);
            break;
        }

        // ── WATERCOLOR ───────────────────────────────────────────────────────
        case "watercolor": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "saturate(1.7) contrast(1.1) brightness(1.2) blur(4px)");
            ctxB.clearRect(0, 0, w, h);
            drawLive(ctxB, video, w, h, "saturate(1.4) contrast(1.6) brightness(1.0)");
            ctx.drawImage(offA, 0, 0);
            ctx.save();
            ctx.globalAlpha = 0.30;
            ctx.drawImage(offB, 0, 0);
            ctx.restore();
            colorWash(ctx, w, h, "rgba(240, 222, 190, 0.50)", "multiply");
            colorWash(ctx, w, h, "rgba(255, 195, 175, 0.18)", "overlay");
            break;
        }

        // ── SKETCH ───────────────────────────────────────────────────────────
        case "sketch": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "grayscale(100%) brightness(1.15)");
            ctxB.clearRect(0, 0, w, h);
            drawLive(ctxB, video, w, h, "grayscale(100%) invert(100%) blur(5px)");
            ctxA.save();
            ctxA.globalCompositeOperation = "color-dodge";
            ctxA.drawImage(offB, 0, 0);
            ctxA.restore();
            ctx.drawImage(offA, 0, 0);
            colorWash(ctx, w, h, "rgba(228, 218, 196, 0.58)", "multiply");
            colorWash(ctx, w, h, "rgba(75, 65, 55, 0.06)", "overlay");
            break;
        }

        // ── OIL PAINTING ─────────────────────────────────────────────────────
        case "oil-painting": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "saturate(2.0) contrast(1.4) brightness(1.05) blur(1.5px)");
            ctx.drawImage(offA, 0, 0);
            colorWash(ctx, w, h, "rgba(200, 130, 60, 0.22)", "overlay");
            colorWash(ctx, w, h, "rgba(255, 210, 130, 0.10)", "screen");
            break;
        }

        // ── HAND-DRAWN ANIME ─────────────────────────────────────────────────
        case "hand-drawn-anime": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "grayscale(0.7) contrast(1.15) brightness(1.05) blur(1px)");
            ctx.drawImage(offA, 0, 0);
            colorWash(ctx, w, h, "rgba(245, 235, 220, 0.45)", "multiply");
            colorWash(ctx, w, h, "rgba(20, 15, 10, 0.08)", "overlay");
            break;
        }

        // ── PIXAR ────────────────────────────────────────────────────────────
        case "pixar": {
            drawLive(ctx, video, w, h, "saturate(2.5) contrast(1.35) brightness(1.12)");
            colorWash(ctx, w, h, "rgba(150, 80, 255, 0.18)", "overlay");
            colorWash(ctx, w, h, "rgba(255, 220, 80, 0.10)", "screen");
            break;
        }

        // ── PORTRAIT ─────────────────────────────────────────────────────────
        case "portrait": {
            drawLive(ctx, video, w, h, "saturate(1.35) contrast(1.12) brightness(1.06)");
            gradientWash(ctx, w, h, "rgba(255, 215, 160, 0.28)", "rgba(25, 15, 55, 0.28)", "overlay");
            colorWash(ctx, w, h, "rgba(255, 180, 180, 0.08)", "soft-light");
            break;
        }

        // ── DEFAULT FALLBACK ─────────────────────────────────────────────────
        default: {
            drawLive(ctx, video, w, h, "saturate(1.8) contrast(1.3) brightness(1.05)");
            colorWash(ctx, w, h, "rgba(200, 140, 80, 0.2)", "overlay");
            break;
        }
    }
}
