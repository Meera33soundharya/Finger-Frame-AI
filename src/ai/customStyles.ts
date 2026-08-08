import type { StyleDef } from '../effects';

const STORAGE_KEY = "finger-frame-custom-styles";

export function loadCustomStyles(): StyleDef[] {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    try {
        return JSON.parse(data);
    } catch (e) {
        console.error("Failed to parse custom styles", e);
        return [];
    }
}

export function saveCustomStyle(style: StyleDef) {
    const styles = loadCustomStyles();
    styles.push(style);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(styles));
}
