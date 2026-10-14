// Собственный набор линейных иконок 24×24 (stroke 1.6). Без эмодзи и сторонних логотипов.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 22, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconHome = (p: P) => <Svg {...p}><path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z" /></Svg>;
export const IconGrid = (p: P) => <Svg {...p}><rect x="4" y="4" width="6.5" height="6.5" /><rect x="13.5" y="4" width="6.5" height="6.5" /><rect x="4" y="13.5" width="6.5" height="6.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" /></Svg>;
export const IconHeart = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p}><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill={filled ? 'currentColor' : 'none'} /></Svg>
);
export const IconBag = (p: P) => <Svg {...p}><path d="M5 8h14l-1 12H6z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></Svg>;
export const IconUser = (p: P) => <Svg {...p}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></Svg>;
export const IconSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></Svg>;
export const IconFilter = (p: P) => <Svg {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconMinus = (p: P) => <Svg {...p}><path d="M5 12h14" /></Svg>;
export const IconChevronRight = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const IconChevronLeft = (p: P) => <Svg {...p}><path d="m15 6-6 6 6 6" /></Svg>;
export const IconChevronDown = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconTrash = (p: P) => <Svg {...p}><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" /></Svg>;
export const IconTruck = (p: P) => <Svg {...p}><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="1.6" /><circle cx="17" cy="18" r="1.6" /></Svg>;
export const IconBox = (p: P) => <Svg {...p}><path d="M4 8 12 4l8 4v8l-8 4-8-4z" /><path d="M4 8l8 4 8-4M12 12v8" /></Svg>;
export const IconPin = (p: P) => <Svg {...p}><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z" /><circle cx="12" cy="10" r="2" /></Svg>;
export const IconChat = (p: P) => <Svg {...p}><path d="M4 5h16v11H9l-5 4z" /></Svg>;
export const IconSend = (p: P) => <Svg {...p}><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>;
export const IconAlert = (p: P) => <Svg {...p}><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.5M12 17v.3" /></Svg>;
export const IconClock = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5l3 2" /></Svg>;
export const IconRuler = (p: P) => <Svg {...p}><path d="M3 15 15 3l6 6L9 21z" /><path d="m7 11 2 2M10 8l2 2M13 5l2 2" /></Svg>;
export const IconDoc = (p: P) => <Svg {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></Svg>;
export const IconShield = (p: P) => <Svg {...p}><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><path d="m9 12 2 2 4-4" /></Svg>;
export const IconSettings = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></Svg>;
export const IconUpload = (p: P) => <Svg {...p}><path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4" /></Svg>;
export const IconRefresh = (p: P) => <Svg {...p}><path d="M20 11a8 8 0 0 0-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4.5l2-2.5M20 20v-5h-5" /></Svg>;
export const IconCard = (p: P) => <Svg {...p}><rect x="3" y="6" width="18" height="12" /><path d="M3 10h18M7 15h3" /></Svg>;
export const IconList = (p: P) => <Svg {...p}><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></Svg>;
export const IconTag = (p: P) => <Svg {...p}><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8" r="1.4" /></Svg>;
export const IconUsers = (p: P) => <Svg {...p}><circle cx="9" cy="8.5" r="3" /><path d="M3 19c.6-3 3-4.7 6-4.7s5.4 1.7 6 4.7M16 5.5a3 3 0 0 1 0 6M18 14.6c1.6.6 2.7 2 3 4.4" /></Svg>;
export const IconImage = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 16-5-5-9 9" /></Svg>;
export const IconExternal = (p: P) => <Svg {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></Svg>;
export const IconEye = (p: P) => <Svg {...p}><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></Svg>;
export const IconArrowUp = (p: P) => <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
export const IconArrowDown = (p: P) => <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>;
export const IconStar = (p: P) => <Svg {...p}><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" /></Svg>;
export const IconMenu = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
