// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import jsQR from 'jsqr';
import { expect, it } from 'vitest';
import { TotpQrCode } from './TotpQrCode.tsx';

it('decodes the rendered enrollment QR into the complete time-based authenticator URI', () => {
    const uri = 'otpauth://totp/swITch:switch.tester1%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=swITch&algorithm=SHA1&digits=6&period=30';
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderToStaticMarkup(createElement(TotpQrCode, { uri, title: 'Authenticator QR' }));
    const svg = wrapper.querySelector('svg')!;
    expect(svg.querySelector('title')?.textContent).toBe('Authenticator QR');
    expect(wrapper.querySelector('img, image')).toBeNull();
    const modules = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    const scale = 4;
    const size = modules * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    // The SVG consists of one-unit-high filled rectangles. Rasterize those
    // rectangles, then use an independent QR decoder to verify the actual image.
    const path = svg.querySelector('path[fill="#000000"]')!.getAttribute('d')!;
    const rectangle = /M(\d+)[ ,](\d+)\s*h(\d+)v1H\d+z/g;
    const segments = [...path.matchAll(rectangle)];
    expect(segments.map((segment) => segment[0]).join('')).toBe(path);
    for (const [, xText, yText, widthText] of segments) {
        const x = Number(xText) * scale;
        const y = Number(yText) * scale;
        const width = Number(widthText) * scale;
        for (let row = y; row < y + scale; row++) {
            for (let col = x; col < x + width; col++) {
                const offset = (row * size + col) * 4;
                pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
            }
        }
    }
    const decoded = jsQR(pixels, size, size);
    expect(decoded?.data).toBe(uri);
    const enrollment = new URL(decoded!.data);
    expect(enrollment.protocol).toBe('otpauth:');
    expect(enrollment.hostname).toBe('totp');
    expect(decodeURIComponent(enrollment.pathname)).toBe('/swITch:switch.tester1@example.com');
    expect(Object.fromEntries(enrollment.searchParams)).toEqual({
        secret: 'JBSWY3DPEHPK3PXP', issuer: 'swITch', algorithm: 'SHA1', digits: '6', period: '30',
    });
});
