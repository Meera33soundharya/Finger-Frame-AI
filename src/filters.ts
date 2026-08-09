// ============================================================
// filters.ts
// REAL-TIME 3D MOVIE / ANIME / SKETCH FILTER ENGINE
// ============================================================

import type { Point } from "./fingerFrame";
import type { StyleId } from "./effects";
import { Compositor } from "./ai/compositor";
import type { FaceWarpResult } from "./faceWarper";


// ------------------------------------------------------------
// Offscreen canvas
// ------------------------------------------------------------

let offscreen: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
// Second offscreen for multi-pass compositing (bloom, edge-detect)
let offscreen2: HTMLCanvasElement | null = null;
let offscreenCtx2: CanvasRenderingContext2D | null = null;

function ensureCanvas(w: number, h: number) {
  if (!offscreen) {
    offscreen = document.createElement("canvas");
    offscreenCtx = offscreen.getContext("2d", { willReadFrequently: false });
    offscreen2 = document.createElement("canvas");
    offscreenCtx2 = offscreen2.getContext("2d", { willReadFrequently: false });
  }

  if (offscreen.width !== w || offscreen.height !== h) {
    offscreen.width = w;
    offscreen.height = h;
    offscreen2!.width = w;
    offscreen2!.height = h;
  }

  return {
    canvas: offscreen,
    ctx: offscreenCtx!,
    canvas2: offscreen2!,
    ctx2: offscreenCtx2!,
  };
}

// Compositor instance for applying AI results to polygon
let compositor: Compositor | null = null;

function getCompositor(): Compositor {
  if (!compositor) {
    compositor = new Compositor();
  }
  return compositor;
}

// ============================================================
// AI-Aware Rendering: Uses getCompositor() to apply AI results
// ============================================================

// ============================================================
// CRITICAL FIX: ctx.filter is silently ignored by Chrome/WebGL when
// ctx.clip() is active. We must bake the filter on the OFFSCREEN canvas
// (no clip there), then draw that result into the clipped main ctx.
// ------------------------------------------------------------

function drawFilteredVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  filter: string,
  alpha: number
) {
  // Step 1: bake filter + mirror onto unclipped offscreen canvas
  const { canvas: off, ctx: offCtx } = ensureCanvas(w, h);
  offCtx.clearRect(0, 0, w, h);
  offCtx.save();
  offCtx.translate(w, 0);
  offCtx.scale(-1, 1);
  offCtx.filter = filter;
  offCtx.drawImage(video, 0, 0, w, h);
  offCtx.filter = "none";
  offCtx.restore();

  // Step 2: draw the baked result into the clipped main ctx
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(off, 0, 0, w, h);
  ctx.restore();
}

// ------------------------------------------------------------
// Draw generated filter image
// ------------------------------------------------------------

function drawFilterImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  w: number,
  h: number,
  alpha: number
) {
  if (!image.complete || image.naturalWidth <= 0) {
    return false;
  }

  ctx.save();

  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "source-over";

  ctx.translate(w, 0);
  ctx.scale(-1, 1);

  ctx.drawImage(image, 0, 0, w, h);

  ctx.restore();

  return true;
}

// ------------------------------------------------------------
// Color overlay
// ------------------------------------------------------------

function overlay(
  ctx: CanvasRenderingContext2D,
  color: string,
  operation: GlobalCompositeOperation,
  w: number,
  h: number,
  alpha: number
) {
  ctx.save();

  ctx.globalCompositeOperation = operation;
  ctx.globalAlpha = alpha;

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

// ------------------------------------------------------------
// 3D MOVIE
// ------------------------------------------------------------

function render3DMovie(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  image: HTMLImageElement | null,
  w: number,
  h: number,
  presence: number
) {
  const { ctx: offCtx, canvas2, ctx2 } = ensureCanvas(w, h);

  // Pass 1: Base cinematic color grade — baked on offscreen1
  offCtx.clearRect(0, 0, w, h);
  offCtx.save();
  offCtx.translate(w, 0);
  offCtx.scale(-1, 1);
  offCtx.filter = "saturate(1.75) contrast(1.22) brightness(1.1) sepia(0.08)";
  offCtx.drawImage(video, 0, 0, w, h);
  offCtx.filter = "none";
  offCtx.restore();

  // Pass 2: Bloom — bright blurred layer composited as screen onto offscreen1
  ctx2.clearRect(0, 0, w, h);
  ctx2.save();
  ctx2.translate(w, 0);
  ctx2.scale(-1, 1);
  ctx2.filter = "saturate(2.5) brightness(1.8) blur(16px) contrast(1.2)";
  ctx2.drawImage(video, 0, 0, w, h);
  ctx2.filter = "none";
  ctx2.restore();
  offCtx.save();
  offCtx.globalCompositeOperation = "screen";
  offCtx.globalAlpha = 0.30;
  offCtx.drawImage(canvas2, 0, 0, w, h);
  offCtx.restore();

  // Pass 3: Warm cinematic top light gradient
  const light = offCtx.createLinearGradient(0, 0, 0, h);
  light.addColorStop(0, "rgba(255,220,160,0.22)");
  light.addColorStop(0.5, "rgba(255,180,100,0.06)");
  light.addColorStop(1, "rgba(30,0,80,0.10)");
  offCtx.save();
  offCtx.globalCompositeOperation = "screen";
  offCtx.globalAlpha = 1;
  offCtx.fillStyle = light;
  offCtx.fillRect(0, 0, w, h);
  offCtx.restore();

  // Composite into clipped main ctx
  ctx.save();
  ctx.globalAlpha = presence;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(offscreen!, 0, 0, w, h);
  ctx.restore();

  // Generated 3D character asset, if available
  if (image) {
    drawFilterImage(ctx, image, w, h, 0.25 * presence);
  }
}

// ------------------------------------------------------------
// ANIME
// ------------------------------------------------------------

function renderAnime(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  image: HTMLImageElement | null,
  w: number,
  h: number,
  presence: number
) {
  const { ctx: offCtx, canvas2, ctx2 } = ensureCanvas(w, h);

  // Pass 1: High saturation anime base
  offCtx.clearRect(0, 0, w, h);
  offCtx.save();
  offCtx.translate(w, 0);
  offCtx.scale(-1, 1);
  offCtx.filter = "saturate(2.2) contrast(1.5) brightness(1.1) hue-rotate(5deg)";
  offCtx.drawImage(video, 0, 0, w, h);
  offCtx.filter = "none";
  offCtx.restore();

  // Pass 2: Edge outline simulation — inverted blurred, multiply
  ctx2.clearRect(0, 0, w, h);
  ctx2.save();
  ctx2.translate(w, 0);
  ctx2.scale(-1, 1);
  ctx2.filter = "grayscale(1) invert(1) blur(2px) contrast(5) brightness(0.4)";
  ctx2.drawImage(video, 0, 0, w, h);
  ctx2.filter = "none";
  ctx2.restore();
  offCtx.save();
  offCtx.globalCompositeOperation = "multiply";
  offCtx.globalAlpha = 0.25;
  offCtx.drawImage(canvas2, 0, 0, w, h);
  offCtx.restore();

  // Pass 3: Anime highlight bloom
  ctx2.clearRect(0, 0, w, h);
  ctx2.save();
  ctx2.translate(w, 0);
  ctx2.scale(-1, 1);
  ctx2.filter = "saturate(3) brightness(2.0) blur(10px)";
  ctx2.drawImage(video, 0, 0, w, h);
  ctx2.filter = "none";
  ctx2.restore();
  offCtx.save();
  offCtx.globalCompositeOperation = "screen";
  offCtx.globalAlpha = 0.22;
  offCtx.drawImage(canvas2, 0, 0, w, h);
  offCtx.restore();

  // Pass 4: Anime skin wash
  offCtx.save();
  offCtx.globalCompositeOperation = "soft-light";
  offCtx.globalAlpha = 0.16;
  offCtx.fillStyle = "rgba(255,140,210,1)";
  offCtx.fillRect(0, 0, w, h);
  offCtx.restore();

  // Composite into clipped main ctx
  ctx.save();
  ctx.globalAlpha = presence;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(offscreen!, 0, 0, w, h);
  ctx.restore();

  if (image) {
    drawFilterImage(ctx, image, w, h, 0.28 * presence);
  }
}

// ------------------------------------------------------------
// SKETCH
// ------------------------------------------------------------

function renderSketch(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  image: HTMLImageElement | null,
  w: number,
  h: number,
  presence: number
) {
  const { ctx: offCtx, canvas2, ctx2 } = ensureCanvas(w, h);

  // Pass 1: Grayscale high contrast pencil base
  offCtx.clearRect(0, 0, w, h);
  offCtx.save();
  offCtx.translate(w, 0);
  offCtx.scale(-1, 1);
  offCtx.filter = "grayscale(1) contrast(1.8) brightness(1.15)";
  offCtx.drawImage(video, 0, 0, w, h);
  offCtx.filter = "none";
  offCtx.restore();

  // Pass 2: Color-dodge edge detection — creates a pencil line look
  ctx2.clearRect(0, 0, w, h);
  ctx2.save();
  ctx2.translate(w, 0);
  ctx2.scale(-1, 1);
  ctx2.filter = "grayscale(1) invert(1) blur(3px) contrast(6) brightness(1.3)";
  ctx2.drawImage(video, 0, 0, w, h);
  ctx2.filter = "none";
  ctx2.restore();
  offCtx.save();
  offCtx.globalCompositeOperation = "color-dodge";
  offCtx.globalAlpha = 0.60;
  offCtx.drawImage(canvas2, 0, 0, w, h);
  offCtx.restore();

  // Pass 3: Warm paper tone
  offCtx.save();
  offCtx.globalCompositeOperation = "multiply";
  offCtx.globalAlpha = 0.30;
  offCtx.fillStyle = "rgba(235, 222, 195, 1)";
  offCtx.fillRect(0, 0, w, h);
  offCtx.restore();

  // Composite into clipped main ctx
  ctx.save();
  ctx.globalAlpha = presence;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(offscreen!, 0, 0, w, h);
  ctx.restore();

  if (image) {
    drawFilterImage(ctx, image, w, h, 0.35 * presence);
  }
}

// ------------------------------------------------------------
// WATERCOLOR
// ------------------------------------------------------------

function renderWatercolor(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  image: HTMLImageElement | null,
  w: number,
  h: number,
  presence: number
) {
  drawFilteredVideo(
    ctx,
    video,
    w,
    h,
    `
      saturate(1.35)
      contrast(1.05)
      brightness(1.18)
    `,
    presence
  );

  // Watercolor paper
  overlay(
    ctx,
    "rgba(255,235,205,1)",
    "multiply",
    w,
    h,
    0.25 * presence
  );

  // Generated watercolor asset
  if (image) {
    drawFilterImage(ctx, image, w, h, 0.30 * presence);
  }
}

// ------------------------------------------------------------
// CYBER ANIME
// ------------------------------------------------------------

function renderCyberAnime(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  image: HTMLImageElement | null,
  w: number,
  h: number,
  presence: number,
  time: number
) {
  drawFilteredVideo(
    ctx,
    video,
    w,
    h,
    `
      saturate(2.2)
      contrast(1.4)
      brightness(0.9)
      hue-rotate(150deg)
    `,
    presence
  );

  overlay(
    ctx,
    `rgba(255,20,190,${0.12 + Math.sin(time * 2.5) * 0.03})`,
    "screen",
    w,
    h,
    presence
  );

  overlay(
    ctx,
    `rgba(0,220,255,${0.10 + Math.cos(time * 2) * 0.03})`,
    "screen",
    w,
    h,
    presence
  );

  if (image) {
    drawFilterImage(ctx, image, w, h, 0.28 * presence);
  }
}

// ------------------------------------------------------------
// OIL PAINTING
// ------------------------------------------------------------

function renderOil(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  presence: number
) {
  drawFilteredVideo(
    ctx,
    video,
    w,
    h,
    `
      saturate(1.5)
      contrast(1.35)
      brightness(0.98)
      sepia(0.18)
    `,
    presence
  );

  overlay(
    ctx,
    "rgba(180,110,40,1)",
    "overlay",
    w,
    h,
    0.18 * presence
  );
}

// ------------------------------------------------------------
// GHIBLI
// ------------------------------------------------------------

function renderGhibli(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  presence: number
) {
  drawFilteredVideo(
    ctx,
    video,
    w,
    h,
    `
      saturate(1.45)
      contrast(1.05)
      brightness(1.2)
    `,
    presence
  );

  overlay(
    ctx,
    "rgba(255,235,180,1)",
    "multiply",
    w,
    h,
    0.12 * presence
  );
}

// ------------------------------------------------------------
// PORTRAIT
// ------------------------------------------------------------

function renderPortrait(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  presence: number
) {
  drawFilteredVideo(
    ctx,
    video,
    w,
    h,
    `
      saturate(1.15)
      contrast(1.15)
      brightness(1.03)
    `,
    presence
  );
}

// ------------------------------------------------------------
// MAIN FILTER
// ------------------------------------------------------------

export function applyLocalFilter(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  polygon: Point[],
  style: StyleId,
  time: number,
  filterImage: HTMLImageElement | null,
  presence = 1,
  _faceResult?: any,
  aiResult?: FaceWarpResult
) {
  // ════════════════════════════════════════════════════════════
  // PRIORITY 1: Use AI-transformed image if available
  // ════════════════════════════════════════════════════════════
  
  if (aiResult?.image) {
    try {
      // Apply the AI-transformed image directly into the polygon
      getCompositor().renderWarped(ctx, aiResult.image, polygon, presence);
      
      // Optionally overlay the reference filter image on top for artistic enhancement
      if (filterImage?.complete && filterImage.naturalWidth > 0) {
        ctx.save();
        ctx.globalAlpha = 0.15 * presence;
        ctx.globalCompositeOperation = "overlay";
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(filterImage, 0, 0, w, h);
        ctx.restore();
      }
      
      return;
    } catch (e) {
      console.warn("AI composition failed, falling back to CSS filters", e);
    }
  }

  // ════════════════════════════════════════════════════════════
  // PRIORITY 2: Fall back to CSS filter-based transformations
  // ════════════════════════════════════════════════════════════

  switch (style) {
    case "movie3d":
      render3DMovie(ctx, video, filterImage, w, h, presence);
      break;

    case "anime":
      renderAnime(ctx, video, filterImage, w, h, presence);
      break;

    case "sketch":
      renderSketch(ctx, video, filterImage, w, h, presence);
      break;

    case "watercolor":
      renderWatercolor(ctx, video, filterImage, w, h, presence);
      break;

    case "cyberpunk":
    case "cyberpunk-girl":
      renderCyberAnime(ctx, video, filterImage, w, h, presence, time);
      break;

    case "oil-painting":
      renderOil(ctx, video, w, h, presence);
      break;

    case "ghibli":
      renderGhibli(ctx, video, w, h, presence);
      break;

    case "portrait":
      renderPortrait(ctx, video, w, h, presence);
      break;

    case "pixar":
      render3DMovie(ctx, video, filterImage, w, h, presence);
      break;

    default:
      render3DMovie(ctx, video, filterImage, w, h, presence);
      break;
  }
}