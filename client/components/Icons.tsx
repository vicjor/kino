import type { JSX } from "react";
const P = (d: string, extra?: JSX.Element) => (props: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />{extra}
  </svg>
);
export const IconSearch = P('M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z');
export const IconGear = P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
export const IconBack = P('M15 18l-6-6 6-6');
export const IconChevron = P('M9 6l6 6-6 6');
export const IconDown = P('M6 9l6 6 6-6');
export const IconLaptop = P('M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9H4zM2 18.5h20');
export const IconPower = P('M12 3v8M6.8 6.6a7.5 7.5 0 1 0 10.4 0');
export const IconGrid = P('M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z');
export const IconInfo = P('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4.5M12 8h.01');
// Solid glyphs for transport controls: outlines read as boxes, not as play/pause/stop.
const F = (shape: JSX.Element) => (props: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="currentColor" aria-hidden="true">{shape}</svg>
);
export const IconPlay = F(<path d="M8 5.2v13.6c0 1.3 1.4 2 2.4 1.3l10.7-6.8c1-.6 1-2 0-2.6L10.4 3.9C9.4 3.2 8 3.9 8 5.2z" />);
export const IconPause = F(<><rect x="6" y="4" width="4.6" height="16" rx="1.6" /><rect x="13.4" y="4" width="4.6" height="16" rx="1.6" /></>);
export const IconStop = F(<rect x="5" y="5" width="14" height="14" rx="3.5" />);
export const IconCast = P('M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6');
export const IconSubs = P('M3 5h18v14H3zM7 15h4M13 15h4M7 11h10');
export const IconFull = P('M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3');
export const IconPip = P('M21 3H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM12 12h8v6h-8z');
// Skip glyphs, after SF Symbols' gobackward.10: a ring open at the top, a solid arrowhead pointing into the gap, and a
// "10" set small enough to leave air inside the ring. Forward is the same drawing mirrored, its digits turned back.
const Skip = (dir: -1 | 1) => (props: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={dir === 1 ? { transform: 'scaleX(-1)' } : undefined}>
    <path d="M11.4 3.54A8.5 8.5 0 1 1 4.85 7.9" />
    <path d="M8.3 3.6l4.5-2.6v5.2z" fill="currentColor" strokeWidth="1.2" />
    <text x="12" y="15.7" textAnchor="middle" fontSize="6.9" fontWeight="700" letterSpacing="-.2" fill="currentColor" stroke="none" fontFamily="inherit" style={dir === 1 ? { transform: 'scaleX(-1)', transformOrigin: '12px 12px' } : undefined}>10</text>
  </svg>
);
export const IconBack10 = Skip(-1);
export const IconFwd10 = Skip(1);
export const IconVol = P('M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14');
export const IconMute = P('M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6');
export const IconPlus = P('M12 5v14M5 12h14');
export const IconCheck = P('M20 6L9 17l-5-5');
export const IconX = P('M18 6L6 18M6 6l12 12');
export const IconHeart = P('M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z');
export const IconBell = P('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0');
export const IconLink = P('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7');
export const IconRefresh = P('M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 15-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15');
export const IconPhone = P('M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01');
export const IconSpeaker = P('M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM12 7.5h.01M12 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
export const IconTv = P('M3 5h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 21h8');
export const IconTrash = P('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6');
export const IconHome = P('M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5');
export const IconLibrary = P('M4 19V5a1 1 0 0 1 1-1h5v16H5a1 1 0 0 1-1-1zM10 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M18.5 5.8l1.9 13.6');
export const IconMagnet = P('M6 3v8a6 6 0 0 0 12 0V3M6 7h4M14 7h4', <><rect x="5" y="2" width="5" height="4" rx="1" /><rect x="14" y="2" width="5" height="4" rx="1" /></>);
export const IconDownload = P('M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2');
export const IconWarn = P('M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z');
export const IconLayers = P('M12 3 2 8l10 5 10-5-10-5zM2 12l10 5 10-5M2 16l10 5 10-5');
export const IconAirplay = P('M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1M12 15l5 6H7l5-6z');
export const IconAudio = P('M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z');
export const IconFilm = P('M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM3 8h18M3 16h18M7 3v18M17 3v18');
export const IconMoon = P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z');
export const IconNext = P('M5 4l10 8-10 8zM19 4v16');
export const IconLock = P('M7 11V7a5 5 0 0 1 10 0v4M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z');
