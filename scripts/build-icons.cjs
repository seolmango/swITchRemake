#!/usr/bin/env node
/**
 * 앱 아이콘(파비콘·PWA·홈 화면)을 타이틀 로고에서 뽑아 낸다.
 *
 * 손으로 그린 아이콘을 따로 두면 로고를 고칠 때 조용히 어긋난다. 그래서 원본은
 * `client/src/components/common/logo.tsx` 하나이고, 여기서는 그 로고의 가운데 표식
 * ─ 화살표 두 개와 뒤집힌 IT ─ 만 잘라 정사각형에 앉힌다. 글자까지 다 넣으면 폰 홈
 * 화면 크기에서 읽히지 않는다(BASE.md §12.1: 잘 보이는 것이 예쁜 것보다 앞선다).
 *
 * 실행: npm run icons:build
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const LOGO = path.join(ROOT, 'client/src/components/common/logo.tsx');
const OUT = path.join(ROOT, 'client/public/icons');

// client/src/theme/color.ts와 같은 값. 아이콘은 테마를 따라가지 못하므로 라이트 쪽으로 고정한다.
const PALETTE = {
    canvas: '#FAFAF8',
    border: '#C6C6C6',
    blueFill: '#BEDFFF',
    blueInk: '#164D99',
    grayFill: '#d3d3d3',
    grayInk: '#3B3B3B',
    redFill: '#FFBDBD',
    redInk: '#8E2042',
};

/** 로고의 세 경로 중 가운데(회색) 것만 쓴다. 서브패스는 위 화살표·⊥·I·아래 화살표 넷이다. */
function markSubpaths() {
    const source = fs.readFileSync(LOGO, 'utf8');
    const paths = [...source.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1]);
    if (paths.length !== 3) throw new Error(`로고 경로가 3개가 아니다(${paths.length}개). logo.tsx를 확인할 것`);
    // 상대 moveto로 이어진 서브패스라 그냥 쪼개면 위치가 무너진다. 앞 서브패스의 시작점을 누적해
    // 절대 좌표로 바꿔 둔다.
    let cursor = [0, 0];
    return paths[1].split(/z\s*/).filter((piece) => piece.trim()).map((piece) => {
        const head = piece.trim().match(/^([Mm])\s*(-?[\d.]+),(-?[\d.]+)([\s\S]*)$/);
        if (!head) throw new Error('서브패스가 moveto로 시작하지 않는다');
        const x = head[1] === 'M' ? Number(head[2]) : cursor[0] + Number(head[2]);
        const y = head[1] === 'M' ? Number(head[3]) : cursor[1] + Number(head[3]);
        cursor = [x, y];
        return `M ${x},${y}${head[4]} z`;
    });
}

const STROKE = 8;
// getBBox()로 잰 표식의 기하 경계. 선 굵기의 절반이 밖으로 나가므로 사방에 STROKE/2를 더한다.
const MARK_BOX = { x: -26.43, y: 5.95, width: 209.52, height: 232.04 };
const BOX = {
    x: MARK_BOX.x - STROKE / 2,
    y: MARK_BOX.y - STROKE / 2,
    width: MARK_BOX.width + STROKE,
    height: MARK_BOX.height + STROKE,
};

/** 위 화살표는 파랑, 아래 화살표는 빨강. 로고의 sw(파랑)와 ch(빨강)를 표식이 그대로 잇는다. */
function markSvg(subpaths, size, markHeight) {
    const scale = markHeight / BOX.height;
    const dx = size / 2 - (BOX.x + BOX.width / 2) * scale;
    const dy = size / 2 - (BOX.y + BOX.height / 2) * scale;
    const skin = [
        { fill: PALETTE.redFill, ink: PALETTE.redInk },    // 아래 화살표
        { fill: PALETTE.grayFill, ink: PALETTE.grayInk },  // ⊥
        { fill: PALETTE.grayFill, ink: PALETTE.grayInk },  // I
        { fill: PALETTE.blueFill, ink: PALETTE.blueInk },  // 위 화살표
    ];
    const paths = subpaths.map((d, index) => `        <path d="${d}" fill="${skin[index].fill}" stroke="${skin[index].ink}"/>`);
    return [
        `    <g transform="translate(${dx.toFixed(3)},${dy.toFixed(3)}) scale(${scale.toFixed(5)})"`,
        `       stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">`,
        ...paths,
        '    </g>',
    ].join('\n');
}

/**
 * @param variant 'rounded' 둥근 사각형(파비콘·일반 아이콘) | 'full' 화면을 꽉 채움(마스커블·iOS)
 */
function iconSvg(subpaths, size, variant, markRatio) {
    const radius = size * 0.22;
    const inset = size * 0.015;
    const plate = variant === 'rounded'
        ? `    <rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${radius}"`
          + ` fill="${PALETTE.canvas}" stroke="${PALETTE.border}" stroke-width="${size * 0.02}"/>`
        : `    <rect width="${size}" height="${size}" fill="${PALETTE.canvas}"/>`;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="swITch">`,
        '    <title>swITch</title>',
        plate,
        markSvg(subpaths, size, size * markRatio),
        '</svg>',
        '',
    ].join('\n');
}

// 마스커블은 바깥 20%가 잘려 나갈 수 있다. 지름 80% 원 안에 들어가는 정사각형이 한 변 56%라
// 표식을 그 아래로 잡는다. iOS는 자기 모서리로만 깎아서 조금 더 키워도 된다.
const VARIANTS = [
    { file: 'icon.svg', size: 512, variant: 'rounded', ratio: 0.78, png: false },
    { file: 'icon-192.png', size: 192, variant: 'rounded', ratio: 0.78, png: true },
    { file: 'icon-512.png', size: 512, variant: 'rounded', ratio: 0.78, png: true },
    { file: 'icon-maskable-512.png', size: 512, variant: 'full', ratio: 0.52, png: true },
    { file: 'apple-touch-icon.png', size: 180, variant: 'full', ratio: 0.66, png: true },
];

(async () => {
    const subpaths = markSubpaths();
    if (subpaths.length !== 4) throw new Error(`표식 서브패스가 4개가 아니다(${subpaths.length}개)`);
    fs.mkdirSync(OUT, { recursive: true });

    const browser = await chromium.launch();
    try {
        for (const spec of VARIANTS) {
            const svg = iconSvg(subpaths, spec.size, spec.variant, spec.ratio);
            const target = path.join(OUT, spec.file);
            if (!spec.png) {
                fs.writeFileSync(target, svg);
                console.log(`wrote ${path.relative(ROOT, target)}`);
                continue;
            }
            const page = await browser.newPage({
                viewport: { width: spec.size, height: spec.size },
                deviceScaleFactor: 1,
            });
            await page.setContent(`<body style="margin:0">${svg}</body>`, { waitUntil: 'load' });
            await page.screenshot({ path: target, omitBackground: spec.variant === 'rounded' });
            await page.close();
            console.log(`wrote ${path.relative(ROOT, target)}`);
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
