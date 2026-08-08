import type { StyleDef } from '../effects';

export async function analyzeImageStyle(file: File): Promise<StyleDef> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        
        img.onload = () => {
            URL.revokeObjectURL(url);
            
            // Analyze the image on a hidden canvas
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error("Failed to get 2D context"));
                return;
            }
            
            canvas.width = 128;
            canvas.height = 128;
            ctx.drawImage(img, 0, 0, 128, 128);
            
            // Simple mock analysis for now
            const id = ("custom_" + Date.now()) as any;
            resolve({
                id,
                label: "Custom " + file.name.substring(0, 10),
                shortcut: "C",
                accentColor: "#a855f7",
                description: "Custom AI style derived from uploaded image.",
                cornerStyle: "bracket",
            });
        };
        
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Failed to load image"));
        };
        
        img.src = url;
    });
}
