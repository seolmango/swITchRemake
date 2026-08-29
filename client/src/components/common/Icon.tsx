import React from 'react';

export type IconName = 'home' | 'person' | 'settings' | 'back' | 'next' | 'refresh' | 'lock' | 'unlock' | 'users' | 'moon' | 'sun' | 'globe' | 'check' | 'keyboard' | 'touch' | 'gamepad' | 'trophy' | 'timer' | 'crown' | 'remove' | 'swap' | 'share' | 'external' | 'shield';

interface IconProps {
    name: IconName;
    size?: number;
    style?: React.CSSProperties;
}

const paths: Record<IconName, React.ReactNode> = {
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V21h13V10.5M9.5 21v-6h5v6"/></>,
    person: <><circle cx="12" cy="8" r="4"/><path d="M4.5 21c.8-4.3 3.3-6.5 7.5-6.5s6.7 2.2 7.5 6.5"/></>,
    settings: <><path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></>,
    back: <path d="m15 5-7 7 7 7"/>,
    next: <path d="m9 5 7 7-7 7"/>,
    refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-1.2 5.8"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    unlock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20c.6-4 2.6-6 6-6s5.4 2 6 6M15 6.5a2.5 2.5 0 0 1 0 5M16 14c2.8.2 4.4 2.2 5 5"/></>,
    moon: <path d="M20 15.4A8 8 0 0 1 8.6 4 8.5 8.5 0 1 0 20 15.4Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></>,
    check: <path d="m5 12 4.5 4.5L19 7"/>,
    keyboard: <><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10"/></>,
    touch: <><path d="M9 11V6a2 2 0 0 1 4 0v5M13 9a2 2 0 0 1 4 0v3M17 11a2 2 0 0 1 4 0v3c0 5-3 8-8 8h-1c-2.2 0-3.7-1.1-4.8-2.8L3.6 14a2 2 0 0 1 3.1-2.4L9 13.5"/></>,
    gamepad: <><path d="M7 8h10a5 5 0 0 1 4.8 6.3l-1 3.6a2.5 2.5 0 0 1-4.2 1.1l-1.8-2H9.2l-1.8 2a2.5 2.5 0 0 1-4.2-1.1l-1-3.6A5 5 0 0 1 7 8Z"/><path d="M7 12v4M5 14h4M16 13h.01M19 15h.01"/></>,
    trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0V4ZM12 13v4M8 21h8M10 17h4"/><path d="M8 6H4v2a4 4 0 0 0 4 4M16 6h4v2a4 4 0 0 1-4 4"/></>,
    timer: <><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/></>,
    shield: <><path d="M12 3l7 3v5.5c0 4.4-2.9 7.7-7 9.5-4.1-1.8-7-5.1-7-9.5V6l7-3Z"/><path d="m9 12 2.2 2.2L15.5 10"/></>,
    crown: <><path d="m3 7 4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7Z"/><path d="M5 21h14"/></>,
    remove: <><circle cx="9" cy="8" r="3"/><path d="M3 20c.6-4 2.6-6 6-6 1.4 0 2.6.3 3.5 1M16 14l5 5M21 14l-5 5"/></>,
    swap: <><path d="M7 7h12l-3-3M19 7l-3 3M17 17H5l3 3M5 17l3-3"/></>,
    share: <><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.7 10.7 6.6-4.2M8.7 13.3l6.6 4.2"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>,
};

export const Icon: React.FC<IconProps> = ({ name, size = 32, style }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
        {paths[name]}
    </svg>
);
