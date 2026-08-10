/**
 * Volcado transaccional a disco (OPFS) usado exclusivamente por
 * `serializeProject` (`core/io.ts`) para no acumular en RAM los píxeles de
 * TODOS los cels de un proyecto grande mientras se guarda: cada cel se
 * suelta de la GPU/RAM justo después de codificarse a PNG, y se restaura
 * antes de que `serializeProject` termine — nunca queda nada a medio
 * cargar cuando el resto de la app puede volver a tocar el documento (el
 * guardado bloquea la entrada mientras dura, ver `App.tsx`). Por eso este
 * módulo no necesita saber nada de `Surface` ni de GPU: sólo escribe y lee
 * bytes bajo una clave de usar-y-tirar.
 *
 * Si el navegador no expone `navigator.storage.getDirectory` (OPFS), o
 * falla por lo que sea (cuota, permisos...), todas las funciones devuelven
 * `false`/`null` en vez de lanzar — el llamador cae de vuelta al camino de
 * siempre (mantener los píxeles en RAM), sin regresión.
 */

const DIR_NAME = 'trace-spill';
let dirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;

function getDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!dirPromise) {
    dirPromise = (async () => {
      try {
        if (!navigator.storage?.getDirectory) return null;
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(DIR_NAME, { create: true });
      } catch {
        return null;
      }
    })();
  }
  return dirPromise;
}

export async function writeSpillBytes(key: string, bytes: Uint8Array): Promise<boolean> {
  const dir = await getDir();
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as BufferSource);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

export async function readSpillBytes(key: string): Promise<Uint8Array | null> {
  const dir = await getDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(key);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function deleteSpillBytes(key: string): Promise<void> {
  const dir = await getDir();
  if (!dir) return;
  try {
    await dir.removeEntry(key);
  } catch {
    // Un archivo huérfano no afecta al documento en memoria — no es crítico.
  }
}
