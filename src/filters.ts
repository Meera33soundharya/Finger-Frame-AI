// ============================================================
//  filters.ts
//  Real-time local visual filter pipeline.
//  Uses Canvas2D to apply different artistic transformations
//  inside the polygon clipping region each frame.
//
//  Each mode applies a different combination of:
//  - CSS filters (saturate/contrast/brightness/hue/blur)
//  - Composite blending modes
//  - Overlay washes and textures
//  - Panning/scaling animations on the reference image
// ============================================================

import type { Point } from "./fingerFrame";
import type { StyleId } from "./effects";

// ── Persistent offscreen canvases (created once, reused every frame) ─
let offA: HTMLCanvasElement | null = null;
let ctxA: CanvasRenderingContext2D | null = null;
let offB: HTMLCanvasElement | null = null;
let ctxB: CanvasRenderingContext2D | null = null;

function ensureOffscreen(w: number, h: number) {
    if (!offA) { offA = document.createElement("canvas"); ctxA = offA.getContext("2d", { willReadFrequently: true })!; }
    if (!offB) { offB = document.createElement("canvas"); ctxB = offB.getContext("2d")!; }
    if (offA.width !== w || offA.height !== h) { offA.width = w; offA.height = h; }
    if (offB.width !== w || offB.height !== h) { offB.width = w; offB.height = h; }
    return { offA, ctxA: ctxA!, offB, ctxB: ctxB! };
}

// ── Helpers ─────────────────────────────────────────────────

/** Draw the mirrored video frame onto an offscreen canvas */
function drawMirroredTo(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, w: number, h: number, filter: string) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.filter = filter;
    ctx.drawImage(video, 0, 0, w, h);
    ctx.filter = "none";
    ctx.restore();
}

/** Get the polygon bounding box */
function bbox(polygon: Point[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polygon) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, pw: maxX - minX, ph: maxY - minY };
}

/** Draw the filter image into the polygon bounding box with cover logic + animation */
function drawImageAnimated(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    polygon: Point[],
    time: number,
    scaleAmp = 0.08,
    panAmpX = 0.04,
    panAmpY = 0.03
) {
    const { minX, minY, pw, ph } = bbox(polygon);
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const polyRatio = pw / ph;

    let dw = pw, dh = ph;
    if (polyRatio > imgRatio) { dh = pw / imgRatio; } else { dw = ph * imgRatio; }

    // Animate: breathing scale + gentle pan
    const scale = 1.0 + scaleAmp * Math.sin(time * 1.8);
    const panX = Math.sin(time * 1.3) * pw * panAmpX;
    const panY = Math.cos(time * 1.1) * ph * panAmpY;

    const cx = minX + pw / 2 + panX;
    const cy = minY + ph / 2 + panY;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  Main exported render function
// ═══════════════════════════════════════════════════════════

/**
 * Called every frame inside the polygon clip region.
 * ctx is already clipped — just draw.
 */
export function applyLocalFilter(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    w: number,
    h: number,
    polygon: Point[],
    style: StyleId,
    time: number,
    filterImage: HTMLImageElement | null
) {
    const { ctxA, ctxB } = ensureOffscreen(w, h);

    // ── 3D Movie — animated character image (breathing + pan) ────────────
    if (style === "movie3d" || style === "pixar") {
        if (filterImage?.complete && filterImage.naturalWidth > 0) {
            drawImageAnimated(ctx, filterImage, polygon, time, 0.08, 0.04, 0.03);
        } else {
            // Fallback: high-saturation video with warm overlay
            drawMirroredTo(ctx, video, w, h, "saturate(2.5) contrast(1.3) brightness(1.1)");
            ctx.globalCompositeOperation = "overlay";
            ctx.fillStyle = "rgba(255, 180, 60, 0.25)";
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = "source-over";
        }
        return;
    }

    // ── Anime — animated image with pastel pink overlay ──────────────────
    if (style === "anime") {
        if (filterImage?.complete && filterImage.naturalWidth > 0) {
            drawImageAnimated(ctx, filterImage, polygon, time + 10, 0.06, 0.03, 0.025);
            // Add soft magenta anime sheen
            ctx.globalCompositeOperation = "screen";
            ctx.fillStyle = "rgba(255, 100, 180, 0.12)";
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = "source-over";
        } else {
            drawMirroredTo(ctx, video, w, h, "saturate(1.8) contrast(1.2) hue-rotate(10deg)");
            ctx.globalCompositeOperation = "screen";
            ctx.fillStyle = "rgba(255, 100, 180, 0.2)";
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = "source-over";
        }
        return;
    }

    // ── Watercolor — live camera content transformed into watercolor ──────
    if (style === "watercolor") {
        // Layer 1: soft blurred saturated base
        ctxA.clearRect(0, 0, w, h);
        drawMirroredTo(ctxA, video, w, h, "saturate(1.6) contrast(1.1) brightness(1.2) blur(3.5px)");

        // Layer 2: sharp detail pass at low opacity
        ctxB.clearRect(0, 0, w, h);
        drawMirroredTo(ctxB, video, w, h, "saturate(1.3) contrast(1.5) brightness(1.0)");

        // Composite: paint the blur on ctx
        ctx.drawImage(offA!, 0, 0);

        // Blend sharp detail at low alpha for edge definition
        ctx.globalAlpha = 0.35;
        ctx.drawImage(offB!, 0, 0);
        ctx.globalAlpha = 1;

        // Warm paper wash (multiply blend)
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = "rgba(240, 225, 195, 0.55)";
        ctx.fillRect(0, 0, w, h);

        // Soft pink/peach paint wash
        ctx.globalCompositeOperation = "overlay";
        ctx.fillStyle = "rgba(255, 200, 180, 0.2)";
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = "source-over";
        return;
    }

    // ── Ghibli — warm dreamy watercolor variant ───────────────────────────
    if (style === "ghibli") {
        ctxA.clearRect(0, 0, w, h);
        drawMirroredTo(ctxA, video, w, h, "saturate(1.9) contrast(1.05) brightness(1.25) blur(4px)");
        ctx.drawImage(offA!, 0, 0);

        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = "rgba(255, 235, 200, 0.45)";
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = "rgba(120, 200, 255, 0.12)";
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = "source-over";
        return;
    }

    // ── Sketch — pencil edge detection via color-dodge ────────────────────
    if (style === "sketch") {
        // Layer A: desaturated video
        ctxA.clearRect(0, 0, w, h);
        drawMirroredTo(ctxA, video, w, h, "grayscale(100%) brightness(1.1)");

        // Layer B: inverted + blurred (dodge source)
        ctxB.clearRect(0, 0, w, h);
        drawMirroredTo(ctxB, video, w, h, "grayscale(100%) invert(100%) blur(5px)");

        // Color-dodge: A + B → pencil lines
        ctxA.globalCompositeOperation = "color-dodge";
        ctxA.drawImage(offB!, 0, 0);
        ctxA.globalCompositeOperation = "source-over";

        ctx.drawImage(offA!, 0, 0);

        // Warm paper tint
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = "rgba(230, 220, 200, 0.6)";
        ctx.fillRect(0, 0, w, h);

        // Subtle graphite tone
        ctx.globalCompositeOperation = "overlay";
        ctx.fillStyle = "rgba(80, 70, 60, 0.08)";
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = "source-over";
        return;
    }

    // ── Cyberpunk — neon glow on live video ───────────────────────────────
    if (style === "cyberpunk") {
        ctxA.clearRect(0, 0, w, h);
        drawMirroredTo(ctxA, video, w, h, "saturate(3) contrast(1.4) brightness(0.8) hue-rotate(180deg)");
        ctx.drawImage(offA!, 0, 0);

        // Magenta neon glow overlay
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = `rgba(255, 0, 180, ${0.15 + 0.05 * Math.sin(time * 3)})`;
        ctx.fillRect(0, 0, w, h);

        // Cyan highlight
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = `rgba(0, 255, 255, ${0.1 + 0.04 * Math.cos(time * 2.5)})`;
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = "source-over";
        return;
    }

    // ── Portrait — soft cinematic portrait look ───────────────────────────
    if (style === "portrait") {
        drawMirroredTo(ctx, video, w, h, "saturate(1.3) contrast(1.1) brightness(1.05)");

        // Vignette-like warm top/cool bottom gradient
        ctx.globalCompositeOperation = "overlay";
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "rgba(255, 220, 170, 0.3)");
        grad.addColorStop(1, "rgba(30, 20, 60, 0.3)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = "source-over";
        return;
    }

    // ── Oil Painting / Default ─────────────────────────────────────────────
    drawMirroredTo(ctx, video, w, h, "saturate(1.8) contrast(1.3) brightness(1.05)");
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = "rgba(200, 140, 80, 0.2)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
}
