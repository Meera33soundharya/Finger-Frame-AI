// ============================================================
//  cyberpunkFilterCPU.ts
//  HIGH-QUALITY CPU fallback — Cyberpunk Anime Art Transformation
//
//  Pipeline (every frame):
//   1. Draw mirrored video → offscreen canvas
//   2. Read pixel data
//   3. Kuwahara 2-quadrant approximation (painted illustrated surface)
//   4. Anime skin-tone detection + 7-band cel shading
//   5. Dual-scale dilated Sobel edges → thick anime ink outlines
//   6. Electric-blue / purple neon rim glow on bright areas
//   7. Animated rain streaks + atmospheric bottom mist
//   8. Write result
//
//  The Kuwahara pass is the key transform that makes the output
//  look illustrated rather than a photographed + tinted image.
// ============================================================

let offCanvas: HTMLCanvasElement | null = null;
let offCtx: CanvasRenderingContext2D | null = null;
let srcCanvas: HTMLCanvasElement | null = null;
let srcCtx: CanvasRenderingContext2D | null = null;

function getOffscreen(w: number, h: number) {
    if (!offCanvas) {
        offCanvas = document.createElement("canvas");
        offCtx = offCanvas.getContext("2d", { willReadFrequently: true })!;
    }
    if (!srcCanvas) {
        srcCanvas = document.createElement("canvas");
        srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true })!;
    }
    if (offCanvas.width !== w || offCanvas.height !== h) { offCanvas.width = w; offCanvas.height = h; }
    if (srcCanvas.width !== w || srcCanvas.height !== h) { srcCanvas.width = w; srcCanvas.height = h; }
    return { offCtx: offCtx!, srcCtx: srcCtx! };
}

const clamp = (v: number, lo = 0, hi = 255) => v < lo ? lo : v > hi ? hi : v;
const luma  = (r: number, g: number, b: number) => r * 0.299 + g * 0.587 + b * 0.114;

// ── Skin tone heuristic (0–1 weight) ─────────────────────────────────────────
function skinWeight(r: number, g: number, b: number): number {
    // Normalised 0..1
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const warm  = Math.max(0, Math.min(1, (rn - bn) / 0.3));
    const light = Math.max(0, Math.min(1, (rn - 0.12) / (0.85 - 0.12)));
    const notSat = 1 - Math.min(1, (Math.abs(rn - gn) + Math.abs(gn - bn)) / 0.6);
    return Math.min(1, warm * light * (0.4 + notSat * 0.6));
}

// ── Kuwahara 4-quadrant approximation at radius=2 ────────────────────────────
// For each pixel, compute mean+variance for four quadrants; pick lowest-variance.
// This is a simplified 3×3 version (each quadrant 2×2 + centre) for CPU speed.
function kuwaharaApprox(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
    const dst = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;

            // Helper: clamp-access pixel luma at (x+dx, y+dy)
            const sample = (dx: number, dy: number) => {
                const nx = Math.min(w - 1, Math.max(0, x + dx));
                const ny = Math.min(h - 1, Math.max(0, y + dy));
                const j  = (ny * w + nx) * 4;
                return [src[j], src[j + 1], src[j + 2]];
            };

            // Four 3×3 quadrants (offsets relative to current pixel)
            const quadOffsets = [
                [[-2,-2],[-1,-2],[0,-2],[-2,-1],[-1,-1],[0,-1],[-2,0],[-1,0],[0,0]],  // TL
                [[ 0,-2],[ 1,-2],[2,-2],[ 0,-1],[ 1,-1],[2,-1],[ 0,0],[ 1,0],[2,0]],  // TR
                [[-2, 0],[-1, 0],[0, 0],[-2, 1],[-1, 1],[0, 1],[-2,2],[-1,2],[0,2]],  // BL
                [[ 0, 0],[ 1, 0],[2, 0],[ 0, 1],[ 1, 1],[2, 1],[ 0,2],[ 1,2],[2,2]],  // BR
            ];

            let bestR = 0, bestG = 0, bestB = 0, bestVar = Infinity;

            for (const offsets of quadOffsets) {
                let sr = 0, sg = 0, sb = 0;
                let sr2 = 0, sg2 = 0, sb2 = 0;
                const n = offsets.length;

                for (const [dx, dy] of offsets) {
                    const [pr, pg, pb] = sample(dx, dy);
                    sr += pr; sg += pg; sb += pb;
                    sr2 += pr * pr; sg2 += pg * pg; sb2 += pb * pb;
                }

                const mr = sr / n, mg = sg / n, mb = sb / n;
                const vr = sr2 / n - mr * mr;
                const vg = sg2 / n - mg * mg;
                const vb = sb2 / n - mb * mb;
                const variance = vr + vg + vb;

                if (variance < bestVar) {
                    bestVar = variance;
                    bestR = mr; bestG = mg; bestB = mb;
                }
            }

            dst[i]     = clamp(bestR);
            dst[i + 1] = clamp(bestG);
            dst[i + 2] = clamp(bestB);
            dst[i + 3] = 255;
        }
    }
    return dst;
}

// ── 4-band anime cel shading with skin awareness and depth falloff ────────────
function celShade(L: number, origR: number, origG: number, origB: number, isBg: number): [number, number, number] {


    // 4 discrete bands for posterized shading
    const Lc = Math.min(1, Math.max(0, (L / 255 - 0.15) * 1.4));
    const band = Math.floor(Lc * 4) / 4;

    // Hand-drawn anime palette (warm beige/cream/sepia)
    const bands: [number, number, number][] = [
        [ 90,  65,  55],   // 0: shadow / dark hair
        [ 165, 125, 105],  // 1: mid shadow
        [ 225, 195, 165],  // 2: base skin / cream
        [ 245, 235, 220],  // 3: highlight
    ];

    const idx = Math.min(3, Math.floor(band * 4));
    let [r, g, b] = bands[idx];

    // Minimal gradient blending at jaw/neck (mix with original a little bit)
    const origBlend = 0.25 * (1 - isBg); 
    const tintedOrigR = (origR * 0.5 + L * 0.5) * 1.1;
    const tintedOrigG = (origG * 0.5 + L * 0.5) * 0.95;
    const tintedOrigB = (origB * 0.5 + L * 0.5) * 0.85;

    r = Math.round(r * (1 - origBlend) + tintedOrigR * origBlend);
    g = Math.round(g * (1 - origBlend) + tintedOrigG * origBlend);
    b = Math.round(b * (1 - origBlend) + tintedOrigB * origBlend);

    return [clamp(r), clamp(g), clamp(b)];
}

// ── Dual-scale Sobel (returns 0..1) ──────────────────────────────────────────
function sobelAt(data: Uint8ClampedArray, w: number, h: number, x: number, y: number, scale: number): number {
    const getL = (dx: number, dy: number) => {
        const nx = Math.min(w - 1, Math.max(0, x + Math.round(dx * scale)));
        const ny = Math.min(h - 1, Math.max(0, y + Math.round(dy * scale)));
        const j  = (ny * w + nx) * 4;
        return luma(data[j], data[j + 1], data[j + 2]);
    };
    const tl = getL(-1, 1), tm = getL(0, 1), tr = getL(1, 1);
    const ml = getL(-1, 0),                  mr = getL(1, 0);
    const bl = getL(-1,-1), bm = getL(0,-1), br = getL(1,-1);
    const gx = -tl - 2*ml - bl + tr + 2*mr + br;
    const gy = -tl - 2*tm - tr + bl + 2*bm + br;
    return Math.sqrt(gx * gx + gy * gy) / 255;
}

// ── Pseudo-random hash ────────────────────────────────────────────────────────
function hash(x: number, y: number): number {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}


const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];

function drawRegionPath(ctx: CanvasRenderingContext2D, landmarks: NormalizedLandmark[], indices: number[], w: number, h: number) {
    ctx.beginPath();
    for (let i = 0; i < indices.length; i++) {
        const lm = landmarks[indices[i]];
        // X is mirrored because the underlying image data is mirrored
        const x = (1 - lm.x) * w;
        const y = lm.y * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

import type { FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { Point } from "./fingerFrameRenderer";

/**
 * Apply the Hand-Drawn Anime CPU filter (repurposed from Cyberpunk).
 * Reads from video, writes to targetCtx.
 * If polygonMask is provided, only processes the bounding box of that mask.
 */
export function processCyberpunkFilterCPU(
    sourceVideo: HTMLVideoElement | HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    _time: number,
    _isGirl: boolean = false,
    polygonMask?: Point[] | null,
    faceResult?: FaceLandmarkerResult | null
) {
    const { offCtx, srcCtx } = getOffscreen(width, height);
    const w = width, h = height;


    // ── 1. Draw mirrored video to source canvas ───────────────────────────────
    srcCtx.save();
    srcCtx.translate(w, 0);
    srcCtx.scale(-1, 1);
    srcCtx.drawImage(sourceVideo, 0, 0, w, h);
    srcCtx.restore();

    const rawData  = srcCtx.getImageData(0, 0, w, h);
    const src      = rawData.data;

    // ── 2. Initialize offscreen canvas with video so out-of-bbox pixels are visible
    //    This prevents the transparent-black border when putImageData only covers the bbox
    offCtx.save();
    offCtx.translate(w, 0);
    offCtx.scale(-1, 1);
    offCtx.drawImage(sourceVideo, 0, 0, w, h);
    offCtx.restore();

    // ── 3. Compute bounding box for efficient processing ─────────────────────────
    let minX = 0, minY = 0, maxX = w - 1, maxY = h - 1;
    if (polygonMask && polygonMask.length > 0) {
        minX = w; minY = h; maxX = 0; maxY = 0;
        for (const p of polygonMask) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        // Expand bounding box slightly to avoid edge artifacts
        minX = Math.max(0, Math.floor(minX) - 10);
        minY = Math.max(0, Math.floor(minY) - 10);
        maxX = Math.min(w - 1, Math.ceil(maxX) + 10);
        maxY = Math.min(h - 1, Math.ceil(maxY) + 10);
    }

    // ── 4. Kuwahara painted surface ─────────────────────────────────────────
    const painted = kuwaharaApprox(src, w, h);

    // ── 5. Per-pixel transformation ─────────────────────────────────────────
    // Use a sub-rect ImageData spanning only [minX..maxX, minY..maxY]
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const out = new Uint8ClampedArray(bboxW * bboxH * 4);

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const si = (y * w + x) * 4;
            const oi = ((y - minY) * bboxW + (x - minX)) * 4;
            const pR = painted[si], pG = painted[si + 1], pB = painted[si + 2];
            const oR = src[si],    oG = src[si + 1],      oB = src[si + 2];
            const L = luma(pR, pG, pB);

            // Depth/Focus heuristic: distance from center of bounding box
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / Math.max(bboxW, bboxH);
            const isBg = Math.max(0, Math.min(1, (dist - 0.25) / 0.35));

            // ── 4. 4-band cel shading ─────────────────────────────────────────
            let [r, g, b] = celShade(L, oR, oG, oB, isBg);

            // ── 5. Watercolor blotches in shadow areas ────────────────────────
            const cHash = hash(Math.floor(x/15), Math.floor(y/15));
            const shadowMask = Math.max(0, 1 - L/150); 
            const blotch = shadowMask * (cHash - 0.5) * 25; // subtle organic variation
            r = clamp(r + blotch);
            g = clamp(g + blotch);
            b = clamp(b + blotch);

            // ── 6. Dry-brush white highlight streaks in hair ──────────────────
            // Approximate hair by looking for non-skin dark/mid regions that are highly illuminated in original
            const origL = luma(oR, oG, oB);
            const sw = skinWeight(oR, oG, oB);
            const hairMask = (1 - sw) * Math.max(0, (origL - 150) / 100); 
            const streakHash = hash(Math.floor(x/2), Math.floor(y/20)); // stretched noise
            if (hairMask > 0.4 && streakHash > 0.6) {
                const highlight = (streakHash - 0.6) * 100;
                r = clamp(r + highlight);
                g = clamp(g + highlight);
                b = clamp(b + highlight);
            }

            // ── 7. Vintage paper grain ────────────────────────────────────────
            const grain = (hash(x, y) - 0.5) * 16;
            r = clamp(r + grain);
            g = clamp(g + grain);
            b = clamp(b + grain);

            // ── 8. Background simplification ──────────────────────────────────
            if (isBg > 0.1) {
                const bgR = 245, bgG = 238, bgB = 228; // flat cream paper
                const blend = Math.min(1, isBg);
                r = Math.round(r * (1 - blend) + bgR * blend);
                g = Math.round(g * (1 - blend) + bgG * blend);
                b = Math.round(b * (1 - blend) + bgB * blend);
            }

            // ── 9. Sobel ink lines ────────────────────────────────────────────
            const inkStrength = 1 - (isBg * 0.6); // fade lines slightly in background
            const e1 = Math.min(1, Math.max(0, (sobelAt(src, w, h, x, y, 1.5) - 0.03) / 0.15));
            const edge = Math.min(1, e1 * 1.5) * inkStrength;

            if (edge > 0.02) {
                const inkR = 20, inkG = 15, inkB = 12; // warm dark ink
                r = Math.round(r * (1 - edge) + inkR * edge);
                g = Math.round(g * (1 - edge) + inkG * edge);
                b = Math.round(b * (1 - edge) + inkB * edge);
            }

            out[oi]     = r;
            out[oi + 1] = g;
            out[oi + 2] = b;
            out[oi + 3] = 255;
        }
    }

    const outImg = new ImageData(out, bboxW, bboxH);
    offCtx.putImageData(outImg, minX, minY);

    // ── 10. Face Detail Enhancements (Ink outlines & slight tints) ────────────
    if (faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
        const landmarks = faceResult.faceLandmarks[0];

        offCtx.save();
        
        // Draw sharp black ink eyeliner
        offCtx.beginPath();
        drawRegionPath(offCtx, landmarks, LEFT_EYE, w, h);
        drawRegionPath(offCtx, landmarks, RIGHT_EYE, w, h);
        offCtx.globalCompositeOperation = "source-over";
        offCtx.strokeStyle = "rgba(20, 15, 12, 0.9)";
        offCtx.lineWidth = 2.5;
        offCtx.stroke();
        
        // Subtle warm lip tint
        offCtx.beginPath();
        drawRegionPath(offCtx, landmarks, LIPS_OUTER, w, h);
        offCtx.clip();
        offCtx.globalCompositeOperation = "multiply";
        offCtx.fillStyle = "rgba(220, 150, 130, 0.3)";
        offCtx.fillRect(0, 0, w, h);
        offCtx.restore();
        
        // Face Jawline Outline (Anime cel outline)
        offCtx.save();
        offCtx.beginPath();
        const JAW = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];
        drawRegionPath(offCtx, landmarks, JAW, w, h);
        offCtx.globalCompositeOperation = "source-over";
        offCtx.strokeStyle = "rgba(20, 15, 12, 0.85)";
        offCtx.lineWidth = 3.0;
        offCtx.stroke();
        offCtx.restore();
    }

    targetCtx.drawImage(offCanvas!, 0, 0, w, h);
}

/**
 * Robust CPU Fallback for Oil Painting
 */
export function processOilPaintingFilterCPU(
    sourceVideo: HTMLVideoElement | HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    polygonMask?: Point[] | null
) {
    const { offCtx, srcCtx } = getOffscreen(width, height);
    const w = width, h = height;

    srcCtx.save();
    srcCtx.translate(w, 0);
    srcCtx.scale(-1, 1);
    srcCtx.drawImage(sourceVideo, 0, 0, w, h);
    srcCtx.restore();

    offCtx.save();
    offCtx.translate(w, 0);
    offCtx.scale(-1, 1);
    offCtx.drawImage(sourceVideo, 0, 0, w, h);
    offCtx.restore();

    let minX = 0, minY = 0, maxX = w - 1, maxY = h - 1;
    if (polygonMask && polygonMask.length > 0) {
        minX = w; minY = h; maxX = 0; maxY = 0;
        for (const p of polygonMask) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        minX = Math.max(0, Math.floor(minX) - 10);
        minY = Math.max(0, Math.floor(minY) - 10);
        maxX = Math.min(w - 1, Math.ceil(maxX) + 10);
        maxY = Math.min(h - 1, Math.ceil(maxY) + 10);
    }

    const rawData = srcCtx.getImageData(0, 0, w, h);
    const src = rawData.data;
    
    // Kuwahara painted surface
    const painted = kuwaharaApprox(src, w, h);

    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const out = new Uint8ClampedArray(bboxW * bboxH * 4);

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const si = (y * w + x) * 4;
            const di = ((y - minY) * bboxW + (x - minX)) * 4;

            let r = painted[si];
            let g = painted[si + 1];
            let b = painted[si + 2];

            const lum = r * 0.299 + g * 0.587 + b * 0.114;
            
            // Contrast
            r = (r - 128) * 1.35 + 128;
            g = (g - 128) * 1.35 + 128;
            b = (b - 128) * 1.35 + 128;
            
            // Warm classical color grading
            const blend = lum / 255;
            const tr = r * (0.8 + blend * 0.4);
            const tg = g * (0.6 + blend * 0.6);
            const tb = b * (0.4 + blend * 0.8);

            // Canvas texture and impasto noise
            const noise = hash(x, y);
            const texNoise = (noise > 0.95) ? -20 : (noise < 0.05) ? 20 : 0;
            const thread = Math.sin(x * 0.5) * Math.cos(y * 0.5) * 10;

            out[di]     = clamp(tr + texNoise + thread);
            out[di + 1] = clamp(tg + texNoise + thread);
            out[di + 2] = clamp(tb + texNoise + thread);
            out[di + 3] = 255;
        }
    }
    const outData = new ImageData(out, bboxW, bboxH);
    offCtx.putImageData(outData, minX, minY);

    targetCtx.save();
    targetCtx.drawImage(offCanvas!, 0, 0, w, h);
    
    // Vignette
    const vig = targetCtx.createRadialGradient(w/2, h/2, h*0.2, w/2, h/2, h*0.9);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(60,30,0,0.6)");
    targetCtx.globalCompositeOperation = "multiply";
    targetCtx.fillStyle = vig;
    targetCtx.fillRect(0, 0, w, h);
    targetCtx.restore();
}

/**
 * Robust CPU Fallback for 3D Anime
 */
export function process3DAnimeFilterCPU(
    sourceVideo: HTMLVideoElement | HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    polygonMask?: Point[] | null
) {
    const { offCtx, srcCtx } = getOffscreen(width, height);
    const w = width, h = height;

    srcCtx.save();
    srcCtx.translate(w, 0);
    srcCtx.scale(-1, 1);
    srcCtx.drawImage(sourceVideo, 0, 0, w, h);
    srcCtx.restore();

    offCtx.save();
    offCtx.translate(w, 0);
    offCtx.scale(-1, 1);
    offCtx.drawImage(sourceVideo, 0, 0, w, h);
    offCtx.restore();

    let minX = 0, minY = 0, maxX = w - 1, maxY = h - 1;
    if (polygonMask && polygonMask.length > 0) {
        minX = w; minY = h; maxX = 0; maxY = 0;
        for (const p of polygonMask) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        minX = Math.max(0, Math.floor(minX) - 10);
        minY = Math.max(0, Math.floor(minY) - 10);
        maxX = Math.min(w - 1, Math.ceil(maxX) + 10);
        maxY = Math.min(h - 1, Math.ceil(maxY) + 10);
    }

    const rawData = srcCtx.getImageData(0, 0, w, h);
    const src = rawData.data;
    
    // Subsurface scattering approx via blurring
    const painted = kuwaharaApprox(src, w, h);

    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const out = new Uint8ClampedArray(bboxW * bboxH * 4);

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const si = (y * w + x) * 4;
            const di = ((y - minY) * bboxW + (x - minX)) * 4;

            const pr = painted[si], pg = painted[si + 1], pb = painted[si + 2];
            const or = src[si],     og = src[si + 1],     ob = src[si + 2];

            let r = pr * 0.7 + or * 0.3;
            let g = pg * 0.7 + og * 0.3;
            let b = pb * 0.7 + ob * 0.3;

            // S-curve contrast
            r = (r - 128) * 1.25 + 128;
            g = (g - 128) * 1.25 + 128;
            b = (b - 128) * 1.25 + 128;

            const lum = r * 0.299 + g * 0.587 + b * 0.114;
            
            if (lum < 100) {
                r *= 0.9;
                g *= 0.85;
                b *= 1.15;
            } else if (lum > 150) {
                r *= 1.1;
                g *= 1.05;
                b *= 0.95;
            }
            
            out[di]     = clamp(r);
            out[di + 1] = clamp(g);
            out[di + 2] = clamp(b);
            out[di + 3] = 255;
        }
    }
    const outData = new ImageData(out, bboxW, bboxH);
    offCtx.putImageData(outData, minX, minY);

    targetCtx.save();
    targetCtx.drawImage(offCanvas!, 0, 0, w, h);
    
    // Glow and color grade
    const glow = targetCtx.createRadialGradient(w*0.5, h*0.35, 0, w*0.5, h*0.35, w*0.65);
    glow.addColorStop(0,   "rgba(255,240,200,0.30)");
    glow.addColorStop(0.6, "rgba(255,240,200,0.05)");
    glow.addColorStop(1,   "rgba(0,0,0,0)");
    targetCtx.globalCompositeOperation = "screen";
    targetCtx.fillStyle = glow;
    targetCtx.fillRect(0, 0, w, h);
    
    targetCtx.globalCompositeOperation = "overlay";
    targetCtx.fillStyle = "rgba(130,70,255,0.14)";
    targetCtx.fillRect(0, 0, w, h);
    
    targetCtx.restore();
}
