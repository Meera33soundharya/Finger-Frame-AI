// ============================================================
//  styleAnalyzer.ts
//  Analyzes a dropped image and derives a StyleDef from it.
//
//  Algorithm:
//   1. Downsample to 64×64 for speed
//   2. K-means colour clustering (k=5) → dominant palette
//   3. Derive accentColor from the most vibrant cluster
//   4. Derive cornerStyle from edge density (Sobel on CPU pixels)
//   5. Derive canvas filter params from saturation/brightness stats
// ============================================================

import type { StyleDef } from '../styles/effects';
import type { CornerStyle } from '../styles/effects';

// ── Tiny k-means (3 iterations, k=5) ─────────────────────────────────────────
interface RGB { r: number; g: number; b: number; }

function distance(a: RGB, b: RGB): number {
    return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function kmeans(pixels: RGB[], k = 5, iterations = 5): RGB[] {
    // Seed with evenly spaced pixels
    const step = Math.max(1, Math.floor(pixels.length / k));
    let centroids: RGB[] = Array.from({ length: k }, (_, i) => ({ ...pixels[i * step] }));

    for (let iter = 0; iter < iterations; iter++) {
        const sums  = Array.from({ length: k }, () => ({ r: 0, g: 0, b: 0, n: 0 }));
        for (const p of pixels) {
            let best = 0, bestD = Infinity;
            for (let c = 0; c < k; c++) {
                const d = distance(p, centroids[c]);
                if (d < bestD) { bestD = d; best = c; }
            }
            sums[best].r += p.r;
            sums[best].g += p.g;
            sums[best].b += p.b;
            sums[best].n++;
        }
        centroids = sums.map((s, i) => s.n > 0
            ? { r: s.r / s.n, g: s.g / s.n, b: s.b / s.n }
            : centroids[i]);
    }
    return centroids;
}

function rgbToHex({ r, g, b }: RGB): string {
    const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Saturation in HSL space (0..1) */
function saturation({ r, g, b }: RGB): number {
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    if (max === min) return 0;
    return (max - min) / (l < 0.5 ? (max + min) : (2 - max - min));
}

/** Brightness (0..1) */
function brightness({ r, g, b }: RGB): number {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// ── Edge density via Sobel on 64×64 greyscale ────────────────────────────────
function edgeDensity(imageData: ImageData, w: number, h: number): number {
    const d = imageData.data;
    let total = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const idx = (y * w + x) * 4;
            const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
            const g00 = luma(d[(idx - w * 4 - 4)], d[(idx - w * 4 - 3)], d[(idx - w * 4 - 2)]);
            const g01 = luma(d[(idx - w * 4)],     d[(idx - w * 4 + 1)], d[(idx - w * 4 + 2)]);
            const g02 = luma(d[(idx - w * 4 + 4)], d[(idx - w * 4 + 5)], d[(idx - w * 4 + 6)]);
            const g10 = luma(d[(idx - 4)],          d[(idx - 3)],          d[(idx - 2)]);
            const g12 = luma(d[(idx + 4)],          d[(idx + 5)],          d[(idx + 6)]);
            const g20 = luma(d[(idx + w * 4 - 4)], d[(idx + w * 4 - 3)], d[(idx + w * 4 - 2)]);
            const g21 = luma(d[(idx + w * 4)],     d[(idx + w * 4 + 1)], d[(idx + w * 4 + 2)]);
            const g22 = luma(d[(idx + w * 4 + 4)], d[(idx + w * 4 + 5)], d[(idx + w * 4 + 6)]);
            const gx = -g00 - 2 * g10 - g20 + g02 + 2 * g12 + g22;
            const gy = -g00 - 2 * g01 - g02 + g20 + 2 * g21 + g22;
            total += Math.hypot(gx, gy);
        }
    }
    return total / ((w - 2) * (h - 2) * 255 * 4);
}

// ── Corner style picker ───────────────────────────────────────────────────────
function pickCornerStyle(edges: number, sat: number): CornerStyle {
    if (edges > 0.22) return "sketch";         // high edge density = sketch/line-art
    if (sat < 0.12)   return "feather";        // desaturated = watercolor/soft
    if (sat > 0.55)   return "glitch";         // very vivid = cyberpunk
    if (edges > 0.10) return "diamond";        // medium edges = anime
    return "bracket";                           // default 3D/portrait
}

// ── Public API ────────────────────────────────────────────────────────────────
export interface ExtractedPalette {
    colors: string[];        // hex strings
    accentColor: string;
    avgSaturation: number;
    avgBrightness: number;
    edgeDensityVal: number;
    cornerStyle: CornerStyle;
}

export async function analyzeImageStyle(file: File): Promise<StyleDef & { palette: ExtractedPalette }> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);

        img.onload = () => {
            URL.revokeObjectURL(url);

            const SAMPLE_SIZE = 64;
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (!ctx) { reject(new Error("No 2D context")); return; }

            canvas.width  = SAMPLE_SIZE;
            canvas.height = SAMPLE_SIZE;
            ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

            const imageData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
            const { data } = imageData;

            // Build pixel list
            const pixels: RGB[] = [];
            for (let i = 0; i < data.length; i += 4) {
                pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
            }

            // K-means
            const clusters = kmeans(pixels, 5, 6);

            // Most vibrant cluster = accent
            const sorted = [...clusters].sort((a, b) => saturation(b) - saturation(a));
            const accentRgb = sorted[0];
            const accentColor = rgbToHex(accentRgb);

            // Average stats
            const avgSat  = clusters.reduce((s, c) => s + saturation(c), 0) / clusters.length;
            const avgBri  = clusters.reduce((s, c) => s + brightness(c), 0) / clusters.length;
            const edges   = edgeDensity(imageData, SAMPLE_SIZE, SAMPLE_SIZE);
            const corner  = pickCornerStyle(edges, avgSat);

            const palette: ExtractedPalette = {
                colors:         clusters.map(rgbToHex),
                accentColor,
                avgSaturation:  avgSat,
                avgBrightness:  avgBri,
                edgeDensityVal: edges,
                cornerStyle:    corner,
            };

            const id = ("custom_" + Date.now()) as StyleDef["id"];
            const labelBase = file.name.replace(/\.[^.]+$/, "").slice(0, 14);
            const shortIdx  = 0; // custom styles get no shortcut key

            resolve({
                id,
                label:        labelBase || "Custom",
                shortcut:     String(shortIdx),
                accentColor,
                description:  `Custom style derived from ${file.name}. Saturation: ${(avgSat * 100).toFixed(0)}%, edges: ${(edges * 100).toFixed(1)}%.`,
                cornerStyle:  corner,
                palette,
            });
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Failed to load image"));
        };

        img.src = url;
    });
}
