// ============================================================
//  animeFilterCPU.ts
//  CPU-based fallback implementation of the Anime filter
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

function kuwaharaApprox(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
    const dst = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const sample = (dx: number, dy: number) => {
                const nx = Math.min(w - 1, Math.max(0, x + dx));
                const ny = Math.min(h - 1, Math.max(0, y + dy));
                const j  = (ny * w + nx) * 4;
                return [src[j], src[j + 1], src[j + 2]];
            };
            const quadOffsets = [
                [[-2,-2],[-1,-2],[0,-2],[-2,-1],[-1,-1],[0,-1],[-2,0],[-1,0],[0,0]],
                [[ 0,-2],[ 1,-2],[2,-2],[ 0,-1],[ 1,-1],[2,-1],[ 0,0],[ 1,0],[2,0]],
                [[-2, 0],[-1, 0],[0, 0],[-2, 1],[-1, 1],[0, 1],[-2,2],[-1,2],[0,2]],
                [[ 0, 0],[ 1, 0],[2, 0],[ 0, 1],[ 1, 1],[2, 1],[ 0,2],[ 1,2],[2,2]],
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
            dst[i] = clamp(bestR); dst[i + 1] = clamp(bestG); dst[i + 2] = clamp(bestB); dst[i + 3] = 255;
        }
    }
    return dst;
}

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

export function processAnimeFilterCPU(
    sourceVideo: HTMLVideoElement | HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    _time: number
) {
    const { offCtx, srcCtx } = getOffscreen(width, height);
    const w = width, h = height;

    srcCtx.save();
    srcCtx.translate(w, 0);
    srcCtx.scale(-1, 1);
    srcCtx.drawImage(sourceVideo, 0, 0, w, h);
    srcCtx.restore();

    const rawData  = srcCtx.getImageData(0, 0, w, h);
    const src      = rawData.data;
    const painted  = kuwaharaApprox(src, w, h);
    const out      = new Uint8ClampedArray(src.length);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            let r = painted[i], g = painted[i + 1], b = painted[i + 2];
            const L = luma(r, g, b) / 255;
            
            // Cel shading (Warm Anime)
            const Lc = Math.min(1, Math.max(0, (L - 0.35) * 1.5 + 0.35));
            const band = Math.floor(Lc * 6) / 6;

            const bands = [
                [ 25,  12,  38],
                [ 63,  38,  63],
                [178, 102, 114],
                [216, 165, 140],
                [242, 216, 191],
                [255, 250, 242]
            ];
            const idx = Math.min(5, Math.floor(band * 6));
            let [cr, cg, cb] = bands[idx];

            r = Math.round(cr * 0.65 + r * 1.1 * 0.35);
            g = Math.round(cg * 0.65 + g * 1.0 * 0.35);
            b = Math.round(cb * 0.65 + b * 1.05 * 0.35);

            const edgeStr = sobelAt(src, w, h, x, y, 1.5);
            const edge = Math.min(1, Math.max(0, (edgeStr - 0.05) / 0.2));
            if (edge > 0.01) {
                const inkR = 20, inkG = 5, inkB = 15;
                r = Math.round(r * (1 - edge) + inkR * edge);
                g = Math.round(g * (1 - edge) + inkG * edge);
                b = Math.round(b * (1 - edge) + inkB * edge);
            }

            if (L > 0.6) {
                const glow = (L - 0.6) / 0.4;
                r += glow * 25; b += glow * 50;
            }

            out[i] = clamp(r); out[i+1] = clamp(g); out[i+2] = clamp(b); out[i+3] = 255;
        }
    }

    const outImg = new ImageData(out, w, h);
    offCtx.putImageData(outImg, 0, 0);
    targetCtx.drawImage(offCanvas!, 0, 0, w, h);
}
