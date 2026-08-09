import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base` sale del entorno porque GitHub Pages sirve el proyecto bajo
 * `/Draw/`, no en la raíz. En desarrollo se queda en `/` para que la IP de
 * la red local siga funcionando sin sufijo.
 */
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
});
