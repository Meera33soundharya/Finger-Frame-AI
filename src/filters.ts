// ============================================================
// filters.ts
// REAL-TIME 3D MOVIE / ANIME / SKETCH FILTER ENGINE
// ============================================================

import type { Point } from "./fingerFrame";
import type { StyleId } from "./effects";

import type { FaceWarpResult } from "./faceWarper";






// ============================================================
// AI-Aware Rendering: Uses getCompositor() to apply AI results
// ============================================================



// ------------------------------------------------------------
// MAIN FILTER
// ------------------------------------------------------------

export function applyLocalFilter(
  ctx: CanvasRenderingContext2D,
  _video: HTMLVideoElement,
  _w: number,
  _h: number,
  polygon: Point[],
  _style: StyleId,
  _time: number,
  filterImage: HTMLImageElement | null,
  presence = 1,
  _faceResult?: any,
  aiResult?: FaceWarpResult
) {
  // ════════════════════════════════════════════════════════════
  // Bounding box of the polygon
  // ════════════════════════════════════════════════════════════
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bx = Math.floor(minX);
  const by = Math.floor(minY);
  const bw = Math.ceil(maxX - minX);
  const bh = Math.ceil(maxY - minY);

  // ════════════════════════════════════════════════════════════
  // PRIORITY 1: Real AI result from Fal.ai backend
  // PRIORITY 2: Mockup static asset (when no AI key is present)
  // ════════════════════════════════════════════════════════════
  const imageToDraw = aiResult?.image || filterImage;

  if (imageToDraw) {
    // Get actual pixel dimensions of the source image/canvas
    const imgW = (imageToDraw as HTMLCanvasElement).width || (imageToDraw as HTMLImageElement).naturalWidth;
    const imgH = (imageToDraw as HTMLCanvasElement).height || (imageToDraw as HTMLImageElement).naturalHeight;

    if (imgW > 0 && imgH > 0) {
      ctx.save();
      ctx.globalAlpha = presence;
      ctx.globalCompositeOperation = "source-over";

      // Cover-style scaling to completely fill the bounding box
      const scale = Math.max(bw / imgW, bh / imgH);
      const drawW = imgW * scale;
      const drawH = imgH * scale;

      // Center the scaled image inside the bounding box
      const drawX = bx + (bw - drawW) / 2;
      const drawY = by + (bh - drawH) / 2;

      ctx.drawImage(imageToDraw, drawX, drawY, drawW, drawH);
      ctx.restore();
    }
  }
}