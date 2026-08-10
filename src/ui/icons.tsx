interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconBrush = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M15.5 3.5 20.5 8.5 10 19a3 3 0 0 1-1.7.9l-3.6.6.6-3.6A3 3 0 0 1 6.2 15z" />
    <path d="m13.5 5.5 5 5" />
  </svg>
);

export const IconEraser = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="m14 4 6 6-8 8H6l-2-2a2 2 0 0 1 0-2.8z" />
    <path d="M20 20h-8" />
  </svg>
);

export const IconFill = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M11 3 4 10a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0l6-6z" />
    <path d="M8 6.5 12.5 11" />
    <path d="M20 15s2 2.4 2 3.8a2 2 0 1 1-4 0C18 17.4 20 15 20 15z" />
  </svg>
);

export const IconDropper = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="m14 6 4 4" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L18 8l-2-2z" />
    <path d="M14.5 7.5 6 16v2H4v2h2l2 0 8.5-8.5z" />
  </svg>
);

export const IconTransform = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="4" width="16" height="16" rx="1" />
    <circle cx="4" cy="4" r="1.6" fill="currentColor" />
    <circle cx="20" cy="4" r="1.6" fill="currentColor" />
    <circle cx="4" cy="20" r="1.6" fill="currentColor" />
    <circle cx="20" cy="20" r="1.6" fill="currentColor" />
  </svg>
);

export const IconBone = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="5" cy="19" r="2" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="5" r="2" />
    <path d="M6.4 17.6 10.6 13.4" />
    <path d="M13.4 10.6 17.6 6.4" />
  </svg>
);

export const IconHand = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M14 11V6.5a1.5 1.5 0 0 1 3 0V14" />
    <path d="M8 12v-1a1.5 1.5 0 0 0-3 0v3a7 7 0 0 0 7 7h1a7 7 0 0 0 7-7v-3" />
  </svg>
);

export const IconLayers = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </svg>
);

export const IconUndo = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9h11a5 5 0 0 1 0 10h-6" />
    <path d="m8 5-4 4 4 4" />
  </svg>
);

export const IconRedo = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M20 9H9a5 5 0 0 0 0 10h6" />
    <path d="m16 5 4 4-4 4" />
  </svg>
);

export const IconPlay = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M7 4.5 19 12 7 19.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconPause = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconPrev = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M18 5.5 8 12l10 6.5z" fill="currentColor" stroke="none" />
    <path d="M6 5v14" />
  </svg>
);

export const IconNext = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M6 5.5 16 12 6 18.5z" fill="currentColor" stroke="none" />
    <path d="M18 5v14" />
  </svg>
);

export const IconOnion = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.5" opacity="0.35" />
    <circle cx="12" cy="12" r="5.5" opacity="0.7" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const IconPlus = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconTrash = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </svg>
);

export const IconCopy = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export const IconEye = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconEyeOff = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 4l16 16" />
    <path d="M9.9 5.8A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3.3 4" />
    <path d="M6.4 8.2A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 3.7-.7" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
);

export const IconLock = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

/** Cuadrícula tipo tablero de ajedrez — la misma metáfora visual que usa
 *  cualquier editor para "hueco transparente", aquí como icono de bloqueo
 *  de alfa (pintar sólo donde ya hay tinta). */
export const IconAlphaLock = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M4 12h8M12 4v8M12 12h8M12 12v8" strokeWidth={1.2} opacity={0.55} />
  </svg>
);

/** Rectángulo con un círculo hueco dentro — la metáfora de "máscara" que
 *  usa cualquier editor gráfico: la parte clara revela, la oscura oculta. */
export const IconMask = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="12" cy="12" r="4.5" strokeWidth={1.2} opacity={0.6} />
  </svg>
);

export const IconText = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M5 6h14M12 6v13" />
  </svg>
);

export const IconMenu = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const IconKey = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="m12 5 4 7-4 7-4-7z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconDownload = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4v10m0 0 4-4m-4 4-4-4" />
    <path d="M5 18h14" />
  </svg>
);

export const IconClose = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const IconSelectRect = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeDasharray="3 2.5">
    <rect x="4" y="5" width="16" height="14" rx="1" />
  </svg>
);

export const IconLasso = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path
      d="M12 4.5c4.4 0 8 2.5 8 5.6 0 2.6-2.5 4.8-6 5.4"
      strokeDasharray="3 2.5"
    />
    <path d="M12 4.5C7.6 4.5 4 7 4 10.1c0 1.8 1.2 3.4 3.1 4.4" strokeDasharray="3 2.5" />
    <path d="M7.1 14.5c.6 1.2.3 2.4-.6 3a1.7 1.7 0 0 1-2.5-1.6c0-.9.7-1.6 1.6-1.7" />
  </svg>
);

/** Selección por semejanza de color: la varita con el destello en la punta. */
export const IconWand = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 19.5 14 10" />
    <path d="M18 3v3.4M16.3 4.7h3.4" />
    <path d="M20.5 9v2M19.5 10h2" />
  </svg>
);

export const IconImage = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="m4 17 5-5 3.5 3.5L17 11l3.5 4" />
  </svg>
);

export const IconVideo = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="6" width="12" height="12" rx="2" />
    <path d="m15.5 10 5-2.7v9.4l-5-2.7z" />
  </svg>
);

export const IconAudio = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M9 6v10.5a2.5 2.5 0 1 1-2-2.45V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9.5a2.5 2.5 0 1 1-2-2.45V7H9z" />
  </svg>
);

export const IconMergeDown = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="3.5" width="16" height="6" rx="1" />
    <path d="M12 11.5v5m0 0 2.5-2.5M12 16.5 9.5 14" />
    <rect x="4" y="18" width="16" height="3" rx="1" fill="currentColor" />
  </svg>
);

export const IconResize = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="6" width="12" height="9" rx="1" strokeDasharray="3 2.5" />
    <path d="M9 21h12V9" />
    <path d="m16 14 5-5m0 0h-4m4 0v4" />
  </svg>
);

export const IconFit = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
  </svg>
);

/** Un trazo suelto a la izquierda que "cristaliza" en un círculo perfecto:
 * el propio icono resume lo que hace QuickShape. */
export const IconFace = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 10.5v.5" />
    <path d="M15.5 10.5v.5" />
    <path d="M8 15c1.2 1 2.6 1.5 4 1.5s2.8-.5 4-1.5" />
  </svg>
);

export const IconQuickShape = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M3 15c1-3 2.5-5 3.5-4.5S7 13 8 12" strokeDasharray="2.5 2" />
    <circle cx="15.5" cy="12" r="5.5" />
  </svg>
);

export const IconSymmetry = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3v18" strokeDasharray="2.5 2" />
    <path d="M12 5c-3 1.5-6 3-6 7s3 5.5 6 7" />
    <path d="M12 5c3 1.5 6 3 6 7s-3 5.5-6 7" strokeOpacity="0.45" />
  </svg>
);

export const IconChevronRight = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);

export const IconFolder = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 6.5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
  </svg>
);
