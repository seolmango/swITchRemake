const IN_APP_PATTERNS = [
    /KAKAOTALK/i,
    /Instagram/i,
    /FBAN|FBAV|FB_IAB|FB4A|FBIOS|FBSS/i,
    /Line\//i,
    /NAVER\(/i,
    /Whale/i,
    /WhatsApp/i,
    /Snapchat/i,
    /Everytimeapp/i,
    /KAKAOSTORY/i,
    /DaumApps/i,
];

export function isInAppBrowser(): boolean {
    return IN_APP_PATTERNS.some((pattern) => pattern.test(navigator.userAgent));
}

export function isAndroid(): boolean {
    return /Android/i.test(navigator.userAgent);
}

export function isIOS(): boolean {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isKakaoTalk(): boolean {
    return /KAKAOTALK/i.test(navigator.userAgent);
}

export function isLine(): boolean {
    return /Line\//i.test(navigator.userAgent);
}

export type ExternalBrowserResult = 'redirected' | 'copied' | 'unavailable';

export async function openInExternalBrowser(): Promise<ExternalBrowserResult> {
    const url = window.location.href;

    if (isKakaoTalk()) {
        window.location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
        return 'redirected';
    }

    if (isLine()) {
        const separator = url.includes('?') ? '&' : '?';
        window.location.href = `${url}${separator}openExternalBrowser=1`;
        return 'redirected';
    }

    if (isAndroid()) {
        const stripped = url.replace(/^https?:\/\//, '');
        window.location.href = `intent://${stripped}#Intent;scheme=https;package=com.android.chrome;end`;
        return 'redirected';
    }

    if (isIOS()) {
        try {
            await navigator.clipboard.writeText(url);
            return 'copied';
        } catch {
            return 'unavailable';
        }
    }

    return 'unavailable';
}
