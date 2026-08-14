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

// ── 7-band anime cel shading with skin awareness ─────────────────────────────
function celShade(L: number, origR: number, origG: number, origB: number): [number, number, number] {
    const sw = skinWeight(origR, origG, origB);

    // Contrast crunch → flat anime zones
    const Lc = Math.min(1, Math.max(0, (L / 255 - 0.42) * 1.55 + 0.42));
    const band = Math.floor(Lc * 7) / 7;

    // Cyberpunk palette bands (shadow → skin → rim → specular)
    const bands: [number, number, number][] = [
        [  3,   5,  20],   // 0: deep black shadow
        [ 13,  20,  56],   // 1: dark blue-indigo
        [ 31,  46, 102],   // 2: mid indigo
        [191, 158, 133],   // 3: anime warm skin
        [230, 199, 173],   // 4: skin highlight
        [199, 230, 250],   // 5: cool rim highlight
        [242, 250, 255],   // 6: bright specular
    ];

    const idx = Math.min(6, Math.floor(band * 7));
    let [r, g, b] = bands[idx];

    // Blend warm skin into skin-detected areas
    if (sw > 0.1) {
        const skinIdx = Math.min(4, Math.max(3, idx));
        const [sr, sg, sb] = bands[skinIdx];
        const t = sw * 0.7;
        r = r * (1 - t) + sr * t;
        g = g * (1 - t) + sg * t;
        b = b * (1 - t) + sb * t;
    }

    // Hue identity blend (20%) — preserves face/hair shape
    const hueR = origR * (sw > 0.1 ? 1.20 : 0.55);
    const hueG = origG * (sw > 0.1 ? 0.95 : 1.15);
    const hueB = origB * (sw > 0.1 ? 0.85 : 1.60);
    r = Math.round(r * 0.80 + clamp(hueR) * 0.20);
    g = Math.round(g * 0.80 + clamp(hueG) * 0.20);
    b = Math.round(b * 0.80 + clamp(hueB) * 0.20);

    return [r, g, b];
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

/**
 * Apply the Cyberpunk Anime CPU filter.
 * Reads from video, writes to targetCtx.
 */
export function processCyberpunkFilterCPU(
    sourceVideo: HTMLVideoElement | HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    time: number,
    _isGirl: boolean = false   // kept for API compat; palette is always cyberpunk
) {
    const { offCtx, srcCtx } = getOffscreen(width, height);
    const w = width, h = height;
    const t = time;

    // ── 1. Draw mirrored video to source canvas ───────────────────────────────
    srcCtx.save();
    srcCtx.translate(w, 0);
    srcCtx.scale(-1, 1);
    srcCtx.drawImage(sourceVideo, 0, 0, w, h);
    srcCtx.restore();

    const rawData  = srcCtx.getImageData(0, 0, w, h);
    const src      = rawData.data;

    // ── 2. Kuwahara painted surface ──────────────────────────────────────────
    const painted  = kuwaharaApprox(src, w, h);

    // ── 3. Per-pixel transformation ──────────────────────────────────────────
    const out      = new Uint8ClampedArray(src.length);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i   = (y * w + x) * 4;
            const pR  = painted[i], pG = painted[i + 1], pB = painted[i + 2];
            const oR  = src[i],    oG = src[i + 1],      oB = src[i + 2];

            // Luminance of painted surface
            const L   = luma(pR, pG, pB);

            // ── 4. 7-band cel shading ─────────────────────────────────────────
            let [r, g, b] = celShade(L, oR, oG, oB);

            // ── 5. Dual-scale Sobel ink lines ─────────────────────────────────
            const e1 = Math.min(1, Math.max(0, (sobelAt(src, w, h, x, y, 1.8) - 0.04) / 0.18));
            const e2 = Math.min(1, Math.max(0, (sobelAt(src, w, h, x, y, 3.5) - 0.06) / 0.19)) * 0.55;
            const edge = Math.min(1, e1 + e2);

            if (edge > 0.01) {
                const inkR = 5, inkG = 3, inkB = 26; // dark blue-purple ink
                r = Math.round(r * (1 - edge) + inkR * edge);
                g = Math.round(g * (1 - edge) + inkG * edge);
                b = Math.round(b * (1 - edge) + inkB * edge);
            }

            // ── 6. Neon rim glow on bright pixels ────────────────────────────
            const origL = L / 255;
            if (origL > 0.55) {
                const glow = Math.min(1, (origL - 0.55) / 0.33);
                const pulse = 0.75 + 0.25 * Math.sin(t * 2.8);
                // Electric-blue specular
                b = clamp(b + Math.round(glow * 140));
                g = clamp(g + Math.round(glow * 40));
                // Purple rim pulse
                const rim = Math.min(1, Math.max(0, (origL - 0.70) / 0.26)) * pulse;
                r = clamp(r + Math.round(rim * 89));
                b = clamp(b + Math.round(rim * 230));
            }

            // ── 7. Animated rain streaks ──────────────────────────────────────
            // Normalise coordinates
            const ux = x / w;
            const uy = y / h;

            // Rain cell
            const rxCell = Math.floor(ux * 0.8 * 35 + t * 0.03 * 35 + 0);
            const ryCell = Math.floor(uy * 1.8 + t * 1.5);
            const rc = hash(rxCell, ryCell);
            const streakX = (ux * 35 + rc * 0.3) % 1;
            const streakFrac = (uy * 1.8 + t * 1.5 + rc) % 1;
            const streakStr = Math.max(0, 1 - Math.abs(streakX - 0.5) * 22);
            const streak = Math.min(1, Math.max(0, (streakStr - 0.95) / 0.05))
                         * Math.min(1, Math.max(0, streakFrac / 0.3)) * 0.12;

            const rain = Math.min(1, streak);
            r = clamp(r + Math.round(rain * 0.15 * 255 * 0.45));
            g = clamp(g + Math.round(rain * 0.55 * 255 * 0.45));
            b = clamp(b + Math.round(rain * 0.95 * 255 * 0.45));

            // ── 8. Atmospheric bottom mist ────────────────────────────────────
            const mistY = Math.min(1, Math.max(0, (uy - 0.65) / 0.35));
            if (mistY > 0) {
                const m = mistY * 0.4;
                r = clamp(Math.round(r * (1 - m) + (r * 0.55 + 10) * m));
                g = clamp(Math.round(g * (1 - m) + (g * 0.55 + 20) * m));
                b = clamp(Math.round(b * (1 - m) + (b * 0.55 + 56) * m));
            }

            // ── 9. Vignette ───────────────────────────────────────────────────
            const vx = ux - 0.5, vy = uy - 0.5;
            const vign = Math.max(0, 1 - (vx * vx + vy * vy) * 1.25);
            r = clamp(Math.round(r * vign));
            g = clamp(Math.round(g * vign));
            b = clamp(Math.round(b * vign));

            out[i]     = r;
            out[i + 1] = g;
            out[i + 2] = b;
            out[i + 3] = 255;
        }
    }

    // Write result
    const outImg = new ImageData(out, w, h);
    offCtx.putImageData(outImg, 0, 0);
    targetCtx.drawImage(offCanvas!, 0, 0, w, h);
}
