import { useState, useEffect, useCallback } from 'react';
import { STYLES as PREDEFINED_STYLES } from '../effects';
import type { StyleDef } from '../effects';
import { loadCustomStyles, saveCustomStyle } from '../ai/customStyles';

export function useAIStyles() {
    const [styles, setStyles] = useState<StyleDef[]>(PREDEFINED_STYLES);

    useEffect(() => {
        const customStyles = loadCustomStyles();
        setStyles([...PREDEFINED_STYLES, ...customStyles]);
    }, []);

    const addCustomStyle = useCallback((style: StyleDef) => {
        saveCustomStyle(style);
        setStyles(prev => [...prev, style]);
    }, []);

    return {
        styles,
        addCustomStyle
    };
}
