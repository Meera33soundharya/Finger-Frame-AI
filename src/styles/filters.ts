// ============================================================
//  filters.ts
//  Real-time local visual filter pipeline.
//  ALL filters use LIVE webcam — no static images, no AI backend.
//
//  Each style applies a unique combination of:
//   - CSS filters (saturate/contrast/brightness/hue/blur)
//   - Canvas composite blending modes
//   - Colour overlay washes & gradients
//   - Animated pulsing effects (time-based)
// ============================================================

import type { Point } from "./fingerFrame";
import type { StyleId } from "./effects";

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
    _quad: Point[],
    style: StyleId,
    time: number,
    filterImage: HTMLImageElement | null
) {
    // We want the live webcam effects to run. If an AI image asset is passed,
    // we can draw it on top with a blend mode, but we must run the live effect first.
    
    const { offA, ctxA, offB, ctxB } = ensureOffscreen(w, h);

    switch (style) {

        // ── 3D MOVIE ─────────────────────────────────────────────────────────
        // Warm golden hour cinema look: punchy saturation + amber grade
        case "movie3d": {
            drawLive(ctx, video, w, h, "saturate(2.2) contrast(1.3) brightness(1.1)");
            colorWash(ctx, w, h, "rgba(255, 170, 50, 0.22)", "overlay");
            colorWash(ctx, w, h, "rgba(255, 200, 100, 0.08)", "screen");
            break;
        }

        // ── ANIME ─────────────────────────────────────────────────────────────
        // Soft-line illustration look: punchy colours + warm magenta sheen
        case "anime": {
            drawLive(ctx, video, w, h, "saturate(2.0) contrast(1.25) brightness(1.1) hue-rotate(8deg)");
            colorWash(ctx, w, h, "rgba(255, 90, 170, 0.18)", "screen");
            colorWash(ctx, w, h, "rgba(200, 230, 255, 0.10)", "soft-light");
            break;
        }

        // ── CYBER BOY ─────────────────────────────────────────────────────────
        // Teal-shifted neon city night
        case "cyberpunk": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "saturate(3) contrast(1.5) brightness(0.75) hue-rotate(160deg)");
            ctx.drawImage(offA, 0, 0);
            colorWash(ctx, w, h, `rgba(0, 220, 255, ${0.12 + 0.05 * Math.sin(time * 2.8)})`, "screen");
            colorWash(ctx, w, h, `rgba(0, 80, 180, ${0.08 + 0.04 * Math.cos(time * 1.5)})`, "overlay");
            break;
        }

        // ── CYBER GIRL ────────────────────────────────────────────────────────
        // Magenta-purple neon dusk — identical pipeline to what was already working
        case "cyberpunk-girl": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "saturate(3) contrast(1.4) brightness(0.8) hue-rotate(180deg)");
            ctx.drawImage(offA, 0, 0);
            colorWash(ctx, w, h, `rgba(255, 0, 180, ${0.15 + 0.05 * Math.sin(time * 3)})`, "screen");
            colorWash(ctx, w, h, `rgba(0, 255, 255, ${0.10 + 0.04 * Math.cos(time * 2.5)})`, "screen");
            break;
        }

        // ── WATERCOLOR ───────────────────────────────────────────────────────
        // Two-pass soft-blur + sharp-detail composite, warm paper overlay
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
        // Classic pencil-sketch colour-dodge: grey base + inverted blur = edges
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
        // Rich layered oils: heavy saturation + warm amber glaze
        case "oil-painting": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "saturate(2.0) contrast(1.4) brightness(1.05) blur(1.5px)");
            ctx.drawImage(offA, 0, 0);
            colorWash(ctx, w, h, "rgba(200, 130, 60, 0.22)", "overlay");
            colorWash(ctx, w, h, "rgba(255, 210, 130, 0.10)", "screen");
            break;
        }

        // ── GHIBLI ───────────────────────────────────────────────────────────
        // Dreamy watercolour with sky-blue sheen + warm paper
        case "ghibli": {
            ctxA.clearRect(0, 0, w, h);
            drawLive(ctxA, video, w, h, "saturate(2.0) contrast(1.08) brightness(1.28) blur(3.5px)");
            ctx.drawImage(offA, 0, 0);
            colorWash(ctx, w, h, "rgba(255, 235, 195, 0.42)", "multiply");
            colorWash(ctx, w, h, "rgba(100, 195, 255, 0.14)", "screen");
            break;
        }

        // ── PIXAR ────────────────────────────────────────────────────────────
        // Bold, vibrant 3D cartoon — high sat + purple accent
        case "pixar": {
            drawLive(ctx, video, w, h, "saturate(2.5) contrast(1.35) brightness(1.12)");
            colorWash(ctx, w, h, "rgba(150, 80, 255, 0.18)", "overlay");
            colorWash(ctx, w, h, "rgba(255, 220, 80, 0.10)", "screen");
            break;
        }

        // ── PORTRAIT ─────────────────────────────────────────────────────────
        // Soft cinematic beauty: warm top, cool shadow bottom
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
