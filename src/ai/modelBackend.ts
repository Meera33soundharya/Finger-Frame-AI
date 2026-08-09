import type { AIModelBackend, InferRequest, InferResult } from './types';

// ──────────────────────────────────────────────────────────
//  LocalStorage key for the Fal.ai API key
// ──────────────────────────────────────────────────────────
export const FAL_KEY_STORAGE = "finger-frame-fal-api-key";

// ──────────────────────────────────────────────────────────
//  Fal.ai Backend — calls the real stable-diffusion img2img API
// ──────────────────────────────────────────────────────────
export class FalAIBackend implements AIModelBackend {
    private apiKey: string;

    // The Fal.ai model we target: fast-sdxl (img2img, ~1-2s on GPU)
    // Docs: https://fal.ai/models/fal-ai/fast-sdxl
    private static MODEL_URL = "https://fal.run/fal-ai/fast-sdxl";

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async initialize(): Promise<void> {
        if (!this.apiKey) throw new Error("Fal.ai API key is required");
        console.log("FalAIBackend initialized");
    }

    private _mockFallback: AsyncAIBackend | null = null;
    private get mockFallback(): AsyncAIBackend {
        if (!this._mockFallback) this._mockFallback = new AsyncAIBackend();
        return this._mockFallback;
    }

    async infer(request: InferRequest): Promise<InferResult> {
        if (!this.apiKey) {
            return this.mockFallback.infer(request);
        }

        const { croppedImage, polygon } = request;
        const base64 = croppedImage.toDataURL("image/jpeg", 0.85);

        const body = {
            prompt: (request.prompt ?? "") + ", no watermark, no text",
            negative_prompt: "blurry, low quality, bad anatomy, extra fingers, multiple faces, duplicate, deformed, text, watermark",
            image_url: base64,
            strength: 0.65,
            num_inference_steps: 20,
            guidance_scale: 7.5,
            image_size: { width: croppedImage.width, height: croppedImage.height },
        };

        try {
            const response = await fetch(FalAIBackend.MODEL_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Key ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.warn(`Fal.ai API error ${response.status}: ${errorText}. Falling back to local filter.`);
                if (response.status === 403) {
                    console.warn("API key balance exhausted or invalid. Removing key from local storage.");
                    localStorage.removeItem(FAL_KEY_STORAGE);
                    this.apiKey = ""; // Disable on this instance to prevent further retries
                }
                return this.mockFallback.infer(request);
            }

            const json = await response.json();
            const outputUrl: string = json.images?.[0]?.url;
            if (!outputUrl) {
                console.warn("No image returned from Fal.ai. Falling back to local filter.");
                return this.mockFallback.infer(request);
            }

            const outputCanvas = await FalAIBackend.urlToCanvas(outputUrl, croppedImage.width, croppedImage.height);
            return { outputCanvas, polygon };
        } catch (e) {
            console.warn("Fal.ai inference failed completely. Falling back to local filter.", e);
            return this.mockFallback.infer(request);
        }
    }

    private static async urlToCanvas(
        url: string,
        w: number,
        h: number
    ): Promise<HTMLCanvasElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas);
            };
            img.onerror = () => reject(new Error("Failed to load result image"));
            img.src = url;
        });
    }

    dispose(): void {}
}

// ──────────────────────────────────────────────────────────
//  Mock backend (used when no API key is set)
//  Simulates the latency of a real inference call.
// ──────────────────────────────────────────────────────────
export class AsyncAIBackend implements AIModelBackend {
    private isInferring = false;

    async initialize(): Promise<void> {
        console.log("AsyncAIBackend (mock) initialized");
    }

    async infer(request: InferRequest): Promise<InferResult> {
        if (this.isInferring) throw new Error("Already inferring");
        this.isInferring = true;

        try {
            // Simulate ~800ms GPU latency
            await new Promise(resolve => setTimeout(resolve, 800));

            const { croppedImage, polygon } = request;

            const resultCanvas = document.createElement("canvas");
            resultCanvas.width = croppedImage.width;
            resultCanvas.height = croppedImage.height;
            const rctx = resultCanvas.getContext("2d")!;

            // Apply a cinematic-style filter to simulate an AI look
            rctx.filter = "saturate(1.8) contrast(1.25) brightness(1.1) blur(0.4px)";
            rctx.drawImage(croppedImage, 0, 0);
            rctx.filter = "none";

            // Bloom pass
            rctx.globalCompositeOperation = "screen";
            rctx.globalAlpha = 0.2;
            const blurCanvas = document.createElement("canvas");
            blurCanvas.width = croppedImage.width;
            blurCanvas.height = croppedImage.height;
            const blurCtx = blurCanvas.getContext("2d")!;
            blurCtx.filter = "blur(8px) brightness(1.4)";
            blurCtx.drawImage(croppedImage, 0, 0);
            rctx.drawImage(blurCanvas, 0, 0);
            rctx.globalAlpha = 1;
            rctx.globalCompositeOperation = "source-over";

            // Warm cinematic tint
            rctx.globalAlpha = 0.1;
            const grad = rctx.createLinearGradient(0, 0, 0, croppedImage.height);
            grad.addColorStop(0, "#ffe4a0");
            grad.addColorStop(1, "#1a0a40");
            rctx.fillStyle = grad;
            rctx.fillRect(0, 0, croppedImage.width, croppedImage.height);
            rctx.globalAlpha = 1;

            return { outputCanvas: resultCanvas, polygon };
        } finally {
            this.isInferring = false;
        }
    }

    dispose(): void {}
}

// ──────────────────────────────────────────────────────────
//  Factory — picks the right backend based on stored key
// ──────────────────────────────────────────────────────────
export function createBackend(): AIModelBackend {
    const key = localStorage.getItem(FAL_KEY_STORAGE)?.trim();
    if (key) {
        return new FalAIBackend(key);
    }
    return new AsyncAIBackend();
}
