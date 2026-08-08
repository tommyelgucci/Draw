import { useEffect, useState } from 'react';

/** Ancho por debajo del cual la interfaz se reorganiza para una mano. */
export const COMPACT_QUERY = '(max-width: 720px)';

/**
 * En pantallas estrechas los deslizadores tienen que ser horizontales, y eso
 * no es sólo cuestión de CSS: el componente lee clientX o clientY según su
 * orientación, así que la decisión tiene que llegar hasta React.
 */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return compact;
}
