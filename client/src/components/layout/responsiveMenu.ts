/** Menu pages use normal document flow on portrait phones; playable canvas routes keep their stage. */
export function supportsPortraitMenu(pathname: string): boolean {
    return ['/', '/login', '/signup', '/reset-password', '/change-password', '/rooms', '/rooms/create', '/rooms/join', '/settings', '/profile', '/how-to-play', '/admin', '/replay'].includes(pathname)
        || /^\/rooms\/[^/]+\/lobby$/u.test(pathname)
        || /^\/matches\/[^/]+\/result$/u.test(pathname);
}
