import { useState, useCallback } from 'react';
import type { DragEvent } from 'react';
import { analyzeImageStyle } from '../ai/styleAnalyzer';
import type { StyleDef } from '../effects';
import './StyleDropZone.css';

interface StyleDropZoneProps {
    onStyleCreated: (style: StyleDef) => void;
}

export function StyleDropZone({ onStyleCreated }: StyleDropZoneProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);

    const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const onDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type.startsWith('image/')) {
                setIsAnalyzing(true);
                try {
                    const newStyle = await analyzeImageStyle(file);
                    onStyleCreated(newStyle);
                } catch (err) {
                    console.error("Style analysis failed", err);
                } finally {
                    setIsAnalyzing(false);
                }
            }
        }
    }, [onStyleCreated]);

    return (
        <div 
            className={`dropzone ${isDragging ? 'dropzone--active' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {isAnalyzing ? (
                <p>Analyzing style...</p>
            ) : (
                <p>Drop image to create AI style</p>
            )}
        </div>
    );
}
