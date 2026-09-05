import { describe, expect, it } from 'vitest';
import { hasReplayBrowserSupport, selectClientEntry } from './browserSupport.ts';

describe('지원 브라우저 진입 판정', () => {
    it('압축 해제 기능이 없으면 앱 대신 지원 안내를 고른다', () => {
        expect(hasReplayBrowserSupport({})).toBe(false);
        expect(selectClientEntry({ DecompressionStream: undefined })).toBe('unsupported');
    });

    it('압축 해제 기능이 있으면 평소 앱으로 들어간다', () => {
        expect(hasReplayBrowserSupport({ DecompressionStream: class TestDecompressionStream {} })).toBe(true);
        expect(selectClientEntry({ DecompressionStream: () => undefined })).toBe('app');
    });

    it.each([
        ['Chrome 103', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/103.0.0.0 Safari/537.36'],
        ['Edge 103', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/103.0.0.0 Safari/537.36 Edg/103.0.0.0'],
        ['Firefox 113', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:113.0) Gecko/20100101 Firefox/113.0'],
        ['Safari 16.4', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_3) AppleWebKit/605.1.15 Version/16.4 Safari/605.1.15'],
        ['iOS Safari 16.4', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1'],
        ['Android Chrome 103', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/103.0.0.0 Mobile Safari/537.36'],
    ])('%s부터 지원한다', (_name, userAgent) => {
        expect(selectClientEntry({ DecompressionStream: class TestDecompressionStream {} }, userAgent)).toBe('app');
    });

    it.each([
        ['iOS Chrome 16.4', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1'],
        ['iOS Firefox 17', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/120.0 Mobile/15E148 Safari/605.1.15'],
        ['iOS Edge 17', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/120.0 Mobile/15E148 Safari/605.1.15'],
        ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36 SamsungBrowser/25.0'],
        ['Android Edge', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36 EdgA/121.0.0.0'],
        ['desktop Opera', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36 OPR/106.0.0.0'],
        ['desktop Vivaldi', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36 Vivaldi/6.5.0.0'],
        ['unknown browser', 'NewBrowser/1.0'],
        ['unparseable Chrome version', 'Mozilla/5.0 Chrome/not-a-version Safari/537.36'],
        ['unparseable iOS version', 'Mozilla/5.0 (iPhone; CPU iPhone OS unknown like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'],
    ])('%s는 기능 탐지를 통과하면 지원한다', (_name, userAgent) => {
        expect(selectClientEntry({ DecompressionStream: class TestDecompressionStream {} }, userAgent)).toBe('app');
    });

    it.each([
        ['Chrome 102', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/102.0.0.0 Safari/537.36'],
        ['Edge 102', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/102.0.0.0 Safari/537.36 Edg/102.0.0.0'],
        ['Firefox 112', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:112.0) Gecko/20100101 Firefox/112.0'],
        ['Safari 16.3', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/605.1.15 Version/16.3 Safari/605.1.15'],
        ['iOS Safari 15', 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile/15E148 Safari/604.1'],
        ['iOS Chrome 15', 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1'],
    ])('%s처럼 최소 버전보다 확실히 낮을 때만 기능이 있어도 거부한다', (_name, userAgent) => {
        expect(selectClientEntry({ DecompressionStream: class TestDecompressionStream {} }, userAgent)).toBe('unsupported');
    });
});
