/**
 * Hook de resolución para `node --test`: el resto del proyecto usa
 * "bundler resolution" (imports relativos sin extensión, como
 * `from './math'`), que es lo que entiende Vite/tsc con
 * `moduleResolution: "bundler"`. El cargador ESM nativo de Node no lo
 * entiende — exige la extensión exacta. En vez de reescribir los imports de
 * `core/` sólo para el test runner (que rompería la convención del resto
 * del código y podría desincronizarse), este hook intenta `.ts` cuando la
 * resolución normal falla.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        // Cae al error original: es más útil que el de este intento.
      }
    }
    throw err;
  }
}
