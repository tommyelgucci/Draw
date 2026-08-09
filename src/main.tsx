import { createRoot } from 'react-dom/client';
import App from './App';

// Sin StrictMode a propósito: su doble montaje en desarrollo crearía dos
// contextos WebGL sobre el mismo canvas y duplicaría las texturas de trabajo.
createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // `BASE_URL` es '/' en local y '/Draw/' en GitHub Pages; el service
    // worker sólo puede controlar páginas dentro de su propio directorio.
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      // Sin service worker la app sigue funcionando; sólo pierde el modo offline.
    });
  });
}
