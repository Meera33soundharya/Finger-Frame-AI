import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Suppress harmless MediaPipe dimension warning
const originalWarn = console.warn;
console.warn = (...args) => {
    if (args[0] && typeof args[0] === 'string' && args[0].includes('NORM_RECT without IMAGE_DIMENSIONS')) {
        return;
    }
    originalWarn(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
