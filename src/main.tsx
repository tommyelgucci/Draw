import { createRoot } from 'react-dom/client';
import App from './App';

// Sin StrictMode a propósito: su doble montaje en desarrollo crearía dos
// contextos WebGL sobre el mismo canvas y duplicaría las texturas de trabajo.
createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sin service worker la app sigue funcionando; sólo pierde el modo offline.
    });
  });
}
