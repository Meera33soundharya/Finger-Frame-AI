import type { AIModelBackend, InferRequest, InferResult } from './types';

// ──────────────────────────────────────────────────────────────────────
//  Fal.ai Backend — FLUX Dev image-to-image
//
//  Model: fal-ai/flux/dev/image-to-image
//  Docs:  https://fal.ai/models/fal-ai/flux/dev/image-to-image
//
//  Requests are forwarded through the Vite proxy (/api/fal/...)
//  which injects the FAL_KEY header server-side.
// ──────────────────────────────────────────────────────────────────────

const NEGATIVE_PROMPT =
    "deformed face, different person, duplicate face, extra eyes, extra fingers, " +
    "bad anatomy, distorted facial features, blurry, low resolution, out of focus, " +
    "oversaturated, muddy colors, black image, dark overlay, jpeg artifacts, " +
    "warped face, uncanny face, random objects, clutter, text, watermark, signature, " +
    "logo, border, frame, multiple people, extra limbs, bad proportions";

export class FalAIBackend implements AIModelBackend {
    // FLUX Dev image-to-image via Vite proxy
    private static MODEL_PATH = "/api/fal/fal-ai/flux/dev/image-to-image";
    private authFailed = false;

    async initialize(): Promise<void> {
        console.log("[AI Filter] FLUX Dev image-to-image backend initialized");
    }

    async infer(request: InferRequest): Promise<InferResult> {
        if (this.authFailed) {
            console.log("[AI Filter] Auth permanently failed — using local fallback");
            return { outputCanvas: null, polygon: request.polygon };
        }

        const { croppedImage, polygon } = request;

        // Validate crop before sending
        if (croppedImage.width < 8 || croppedImage.height < 8) {
            return { outputCanvas: null, polygon };
        }

        // Encode the cropped region as a base64 data URL
        const imageDataUrl = croppedImage.toDataURL("image/jpeg", 0.90);

        // FLUX Dev image-to-image request body
        const body = {
            image_url: imageDataUrl,
            prompt: (request.prompt ?? "cinematic portrait, high quality, photorealistic") +
                    ", no watermark, no text, high detail, sharp focus",
            negative_prompt: NEGATIVE_PROMPT,
            // Conservative strength — preserves 65-80% of original structure
            strength: 0.35,
            num_inference_steps: 28,
            guidance_scale: 3.5,   // FLUX uses lower CFG than SDXL
            seed: Math.floor(Math.random() * 9999999),
            enable_safety_checker: false,
            // Output at the same resolution as the crop
            image_size: {
                width:  Math.max(64, Math.min(1024, croppedImage.width)),
                height: Math.max(64, Math.min(1024, croppedImage.height)),
            },
            // Return a single image
            num_images: 1,
        };

        try {
            console.log(`[AI Filter] Request started → FLUX Dev img2img (${body.image_size.width}×${body.image_size.height})`);
            const response = await fetch(FalAIBackend.MODEL_PATH, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "(no body)");

                if (response.status === 401 || response.status === 403) {
                    console.error(
                        `[AI Filter] Auth error ${response.status}. ` +
                        "Ensure FAL_KEY is set in .env and dev server was restarted."
                    );
                    this.authFailed = true;
                    return { outputCanvas: null, polygon };
                }

                console.warn(`[AI Filter] API error ${response.status}: ${errorText} — falling back to local filter`);
                return { outputCanvas: null, polygon };
            }

            const json = await response.json();
            // FLUX returns: { images: [{ url, content_type }], timings, ... }
            const outputUrl: string | undefined =
                json?.images?.[0]?.url ??
                json?.image?.url ??      // some model variants
                json?.output;            // legacy

            if (!outputUrl) {
                console.warn("[AI Filter] No image URL in response:", JSON.stringify(json).slice(0, 200));
                return { outputCanvas: null, polygon };
            }

            console.log(`[AI Filter] Result received`);
            const outputCanvas = await FalAIBackend.urlToCanvas(
                outputUrl,
                croppedImage.width,
                croppedImage.height,
            );
            console.log(`[AI Filter] Result dimensions: ${outputCanvas.width}×${outputCanvas.height}`);
            return { outputCanvas, polygon };

        } catch (e) {
            console.error("[AI Filter] ERROR:", e);
            console.log("[AI Filter] Falling back to original camera");
            return { outputCanvas: null, polygon };
        }
    }

    private static async urlToCanvas(url: string, w: number, h: number): Promise<HTMLCanvasElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width  = w;
                canvas.height = h;
                canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
                resolve(canvas);
            };
            img.onerror = () => reject(new Error("Failed to load AI result image"));
            img.src = url;
        });
    }

    dispose(): void {}
}

// ──────────────────────────────────────────────────────────
//  Factory — picks the right backend
// ──────────────────────────────────────────────────────────
export function createBackend(): AIModelBackend {
    return new FalAIBackend();
}
