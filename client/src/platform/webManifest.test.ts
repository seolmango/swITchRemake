import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 설치 정보는 파일 세 곳(매니페스트·index.html·public/icons)에 흩어져 있어서, 아이콘 이름을
 * 하나 바꾸면 나머지가 조용히 빈 칸을 가리킨다. 홈 화면에 아이콘이 안 뜨는 것은 배포하고
 * 폰으로 깔아 봐야 알게 되는 종류의 고장이라 여기서 잡는다.
 */
const publicFile = (name: string) => fileURLToPath(new URL(`../../public/${name}`, import.meta.url));

const manifest = JSON.parse(readFileSync(publicFile('manifest.webmanifest'), 'utf8'));
const indexHtml = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

describe('web app manifest', () => {
    it('carries what a browser needs before it offers to install', () => {
        expect(manifest.name).toBe('swITch');
        expect(manifest.start_url).toBe('/');
        expect(manifest.scope).toBe('/');
        expect(manifest.display).toBe('standalone');
        expect(manifest.description.length).toBeGreaterThan(0);
    });

    it('does not lock the screen to one rotation', () => {
        // BASE.md §12 — 세로에서도 조작할 수 있어야 하고, 가로는 권하는 것이지 막는 것이 아니다.
        expect(manifest.orientation).toBe('any');
    });

    it('ships every icon it advertises, including a maskable one', () => {
        const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
        expect(sizes).toContain('192x192');
        expect(sizes).toContain('512x512');
        expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true);
        for (const icon of manifest.icons as { src: string }[]) {
            expect(existsSync(publicFile(icon.src.replace(/^\//, '')))).toBe(true);
        }
    });
});

describe('index.html', () => {
    it('points at the manifest and at icons that exist', () => {
        expect(indexHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
        const referenced = [...indexHtml.matchAll(/href="(\/icons\/[^"]+)"/g)].map((match) => match[1]!);
        expect(referenced.length).toBeGreaterThan(0);
        for (const href of referenced) expect(existsSync(publicFile(href.replace(/^\//, '')))).toBe(true);
    });

    it('names an apple touch icon, the only way iOS gets one', () => {
        expect(indexHtml).toContain('rel="apple-touch-icon"');
    });
});
