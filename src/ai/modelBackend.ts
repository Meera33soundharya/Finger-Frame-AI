import type { AIModelBackend, InferRequest, InferResult } from './types';

// ──────────────────────────────────────────────────────────
//  Fal.ai Backend — calls the real stable-diffusion img2img API
//  Authentication is now handled securely via a Vite proxy.
// ──────────────────────────────────────────────────────────
export class FalAIBackend implements AIModelBackend {
    // We target our secure Vite proxy endpoint
    private static MODEL_URL = "/api/fal/fal-ai/fast-sdxl";
    private authFailed = false;

    async initialize(): Promise<void> {
        console.log("FalAIBackend initialized via secure proxy");
    }

    private _mockFallback: AsyncAIBackend | null = null;
    private get mockFallback(): AsyncAIBackend {
        if (!this._mockFallback) this._mockFallback = new AsyncAIBackend();
        return this._mockFallback;
    }

    async infer(request: InferRequest): Promise<InferResult> {
        // If authentication failed permanently, stop spamming the proxy/backend
        // and just immediately use the local mock fallback.
        if (this.authFailed) {
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
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                // On 401 or 403, it's a permanent configuration error.
                // Do not retry. Throw a specific error to break the loop.
                if (response.status === 401 || response.status === 403) {
                    console.error(`Fal.ai Auth Error ${response.status}: Missing or invalid API key. Set FAL_KEY in .env`);
                    this.authFailed = true;
                    throw new Error("AUTH_FAILED");
                }
                
                console.warn(`Fal.ai API error ${response.status}: ${errorText}. Falling back to local filter.`);
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
            if (e instanceof Error && e.message === "AUTH_FAILED") {
                throw e; // Bubble up to stop the loop
            }
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

    async infer(_request: InferRequest): Promise<InferResult> {
        if (this.isInferring) throw new Error("Already inferring");
        this.isInferring = true;

        try {
            // Simulate ~800ms GPU latency
            await new Promise(resolve => setTimeout(resolve, 800));

            // We don't want to return a CSS-filtered webcam crop anymore.
            // Returning a null outputCanvas here will cause the frontend to gracefully fall back 
            // to the local CSS filters which perfectly fits the user's requirements without spamming the console.
            return { outputCanvas: null, polygon: _request.polygon };
        } finally {
            this.isInferring = false;
        }
    }

    dispose(): void {}
}

// ──────────────────────────────────────────────────────────
//  Factory — picks the right backend
// ──────────────────────────────────────────────────────────
export function createBackend(): AIModelBackend {
    return new FalAIBackend();
}
