export interface ReplayBrowserCapabilities {
    DecompressionStream?: unknown;
}

const versionAtLeast = (actual: string, minimumMajor: number, minimumMinor = 0): boolean => {
    const [major = 0, minor = 0] = actual.split('.').map(Number);
    return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
};

const isKnownUnsupportedUserAgent = (userAgent: string): boolean => {
    if (!userAgent.trim()) return false;
    const ios = /iPhone|iPad|iPod/iu.test(userAgent);
    const android = /Android/iu.test(userAgent);
    const iosVersion = userAgent.match(/CPU(?: iPhone)? OS (\d+)[._](\d+)/u);
    const edge = userAgent.match(/Edg\/(\d+(?:\.\d+)?)/u);
    const chrome = userAgent.match(/Chrome\/(\d+(?:\.\d+)?)/u);
    const firefox = userAgent.match(/Firefox\/(\d+(?:\.\d+)?)/u);
    const safari = userAgent.match(/Version\/(\d+(?:\.\d+)?).+Safari\//u);

    if (ios) {
        return iosVersion !== null
            && !versionAtLeast(`${iosVersion[1]}.${iosVersion[2]}`, 16, 4);
    }
    if (android) {
        if (/EdgA|OPR|SamsungBrowser/iu.test(userAgent)) return false;
        return chrome !== null && !versionAtLeast(chrome[1]!, 103);
    }
    if (edge) return !versionAtLeast(edge[1]!, 103);
    if (chrome && !/OPR|Vivaldi|YaBrowser/iu.test(userAgent)) return !versionAtLeast(chrome[1]!, 103);
    if (firefox) return !versionAtLeast(firefox[1]!, 113);
    if (safari) return !versionAtLeast(safari[1]!, 16, 4);
    return false;
};

/** 리플레이를 끝까지 읽을 수 있는 브라우저인지 앱을 띄우기 전에 확인한다. */
export const hasReplayBrowserSupport = (capabilities: ReplayBrowserCapabilities, userAgent = ''): boolean =>
    typeof capabilities.DecompressionStream === 'function' && !isKnownUnsupportedUserAgent(userAgent);

export const selectClientEntry = (capabilities: ReplayBrowserCapabilities, userAgent = ''): 'app' | 'unsupported' =>
    hasReplayBrowserSupport(capabilities, userAgent) ? 'app' : 'unsupported';
