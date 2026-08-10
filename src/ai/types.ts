import type { Point } from '../fingerFrame';

export interface StyleAnalysis {
    id: string;
    label: string;
    description: string;
    accentColor: string;
    features: {
        saturation: number;
        brightness: number;
        edgeDensity: number;
        colorTemperature: number;
    };
    baseStyle: string;
}

export interface InferRequest {
    croppedImage: HTMLCanvasElement; // The extracted bounding box
    prompt: string;
    polygon: Point[];
    timestamp: number;
    presence: number;
}

export interface InferResult {
    outputCanvas: HTMLCanvasElement | null; // The AI generated image matching the bounding box, or null if falling back
    polygon: Point[]; // The original polygon this was requested for, used for aligning back
}

export interface AIModelBackend {
    initialize(): Promise<void>;
    infer(request: InferRequest): Promise<InferResult>;
    dispose(): void;
}
