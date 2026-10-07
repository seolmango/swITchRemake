'use strict';
/*
 * swITch 맵 에디터. 맵 원본(map/*.json + *.csv)을 그대로 읽고 쓴다 — 에디터만의 형식은 없다.
 *
 * 검사 규칙과 자기장·시작 위치 미리보기는 builder.py와 같은 계산이다. 둘이 어긋나면 builder.py가 원본이고
 * 이 파일을 맞춘다. 실제 판정은 빌드할 때 builder.py가 한 번 더 한다.
 */

const MARKER_KINDS = {
    'skill.dash': ['유체화 스킬', '#0a6fd6'],
    'skill.flash': ['점멸 스킬', '#7b3fd6'],
    'skill.exhaust': ['탈진 스킬', '#b26b00'],
    tagger: ['술래 되기', '#e60012'],
    reset: ['초기화', '#1a7f37'],
    'training.chaseMode': ['추격 모드', '#d65a00'],
    'training.dummy.still': ['표적(정지)', '#555555'],
    'training.dummy.patrol': ['표적(순찰)', '#555555'],
    'training.dummy.chase': ['표적(추격)', '#555555'],
};
const ZONE_KINDS = {
    'training.course': ['훈련 코스', '#d65a00'],
    'training.chase': ['추격장', '#0a6fd6'],
};
const TOOLS = [
    ['brush', '브러시', 'B'], ['rect', '사각형', 'R'], ['pick', '스포이트', 'I'],
    ['marker', '마커', 'M'], ['zone', '구역', 'G'], ['cell', '칸', 'C'],
];
const WALL = 1; // physics 값. 1=벽, 2=수풀, 3=연막, 0=바닥

const $ = (id) => document.getElementById(id);
const state = {
    setting: null,
    tiles: new Map(),      // num -> { num, name, physics, img }
    tileSize: 256,
    map: null,             // { file, name, size, barrier, training, markers, zones, cells }
    tool: 'brush',
    brush: 1,
    markerKind: 'skill.dash',
    zoneKind: 'training.course',
    selected: null,
    undo: [], redo: [],
    dirty: false,
    drag: null,
    previewTick: 0,
    previewPlayers: 0,
    simCache: null,
};

// ── 형식 ───────────────────────────────────────────────────────────────

/** CSV 칸: `시작타일/틱:타일/.../*:타일`. `*`는 자기장이 닿았을 때 그 칸(벽·연막)이 바뀔 타일이다. */
function parseCell(text) {
    const [start, ...rest] = text.trim().split('/');
    return {
        start: Number(start),
        changes: rest.filter(Boolean).map((part) => {
            const [tick, tile] = part.split(':');
            return [tick === '*' ? '*' : Number(tick), Number(tile)];
        }),
    };
}
const formatCell = (cell) => [String(cell.start), ...cell.changes.map(([tick, tile]) => `${tick}:${tile}`)].join('/');

function parseMap(file, json, csv) {
    const rows = csv.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split(','));
    const cells = [];
    for (let y = 0; y < json.size; y++) {
        cells.push([]);
        for (let x = 0; x < json.size; x++) cells[y].push(parseCell(rows[y]?.[x] ?? '0'));
    }
    return {
        file, name: json.name, size: json.size, barrier: json.barrier, training: Boolean(json.training),
        markers: (json.markers ?? []).map((m) => ({ ...m })), zones: (json.zones ?? []).map((z) => ({ ...z })), cells,
    };
}

function serializeMap(map) {
    const json = { name: map.name, size: map.size, barrier: map.barrier };
    if (map.training) json.training = true;
    json.markers = map.markers;
    json.zones = map.zones;
    const csv = map.cells.map((row) => row.map(formatCell).join(',')).join('\n') + '\n';
    return { json, csv };
}

// ── builder.py와 같은 계산 ────────────────────────────────────────────

const physicsOf = (num) => state.tiles.get(num)?.physics;

function lastTile(cell) {
    return cell.changes.length ? cell.changes[cell.changes.length - 1][1] : cell.start;
}

/** builder.py의 자기장 시뮬레이션. `untilTick`까지 진행한 타일 배치와 자기장 안쪽 거리(px)를 돌려준다. */
function simulate(map, untilTick) {
    const { size } = map;
    const tile = state.tileSize;
    const endpoint = size * (tile / 2);
    const current = map.cells.map((row) => row.map((cell) => cell.start));
    const events = new Map();
    map.cells.forEach((row, y) => row.forEach((cell, x) => {
        for (const [tick, to] of cell.changes) {
            if (tick === '*') continue;
            if (!events.has(tick)) events.set(tick, []);
            events.get(tick).push([x, y, to]);
        }
    }));
    let barrier = 0;
    let tick = 0;
    while (barrier < endpoint && tick < untilTick) {
        tick++;
        barrier += map.barrier;
        for (const [x, y, to] of events.get(tick) ?? []) {
            const distance = Math.min(x, y, size - x - 1, size - y - 1) * tile - barrier;
            if (distance >= -tile) current[y][x] = to;
        }
        const d = Math.floor(barrier / tile) + 1;
        for (let t = d; t < size - d; t++) {
            for (const [x, y] of [[d, t], [size - d - 1, t], [t, d], [t, size - d - 1]]) {
                if ([1, 3].includes(physicsOf(current[y][x]))) current[y][x] = lastTile(map.cells[y][x]);
            }
        }
    }
    return { tiles: current, barrier, endTick: Math.ceil(endpoint / Math.max(1, map.barrier)) };
}

/** builder.py의 시작 위치. 원 위에 고르게 놓고, 벽이면 가까운 바닥으로 옮긴다. */
function startPositions(map, players) {
    const size = map.size;
    const c = (size - 1) / 2;
    const radius = (size * (0.7 + (players - 3) * 0.03)) / 2;
    const out = [];
    for (let k = 0; k < players; k++) {
        const angle = (2 * Math.PI * k) / players + (2 * Math.PI * players) / 18;
        let sx = Math.max(0, Math.min(Math.round(c + radius * Math.cos(angle)), size - 1));
        let sy = Math.max(0, Math.min(Math.round(c + radius * Math.sin(angle)), size - 1));
        if (physicsOf(map.cells[sy][sx].start) === WALL) {
            const origin = Math.hypot(sx - c, sy - c);
            outer: for (let r = 1; r < Math.max(5, Math.floor(size / 2)); r++) {
                const candidates = [];
                for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const nx = sx + dx, ny = sy + dy;
                    if (nx < 0 || ny < 0 || nx >= size || ny >= size || physicsOf(map.cells[ny][nx].start) === WALL) continue;
                    candidates.push([Math.hypot(dx, dy) - 0.5 * (Math.hypot(nx - c, ny - c) - origin), nx, ny]);
                }
                if (candidates.length) { candidates.sort((a, b) => a[0] - b[0]); [, sx, sy] = candidates[0]; break outer; }
            }
        }
        out.push([sx, sy]);
    }
    return out;
}

/** builder.py의 검사와 같은 것 + 빌드 전에 알면 좋은 것. */
function problems(map) {
    const out = [];
    const add = (text) => out.push(text);
    if (!map.name?.trim()) add('맵 이름이 비어 있다');
    if (!Number.isInteger(map.size) || map.size < 10) add('크기는 10 이상의 정수여야 한다');
    if (!Number.isInteger(map.barrier) || map.barrier <= 0) add('자기장 속도는 1 이상의 정수여야 한다');
    map.cells.forEach((row, y) => row.forEach((cell, x) => {
        for (const num of [cell.start, ...cell.changes.map(([, t]) => t)]) {
            if (!state.tiles.has(num)) add(`(${x}, ${y}) 칸에 없는 타일 번호 ${num}`);
        }
        if (cell.changes.some(([tick]) => tick !== '*' && (!Number.isInteger(tick) || tick <= 0))) add(`(${x}, ${y}) 칸의 틱은 1 이상의 정수여야 한다`);
        if (cell.changes.filter(([tick]) => tick === '*').length > 1) add(`(${x}, ${y}) 칸에 *가 둘 이상이다`);
    }));
    const seen = new Set();
    map.markers.forEach((m, i) => {
        const where = `마커 ${i + 1}(${m.x}, ${m.y})`;
        if (!MARKER_KINDS[m.kind]) add(`${where}: 모르는 종류 ${m.kind}`);
        if (m.x < 0 || m.y < 0 || m.x >= map.size || m.y >= map.size) { add(`${where}: 맵 밖이다`); return; }
        if (physicsOf(map.cells[m.y][m.x].start) === WALL) add(`${where}: 벽 위에 있다`);
        if (seen.has(`${m.x},${m.y}`)) add(`${where}: 같은 칸에 마커가 둘이다`);
        seen.add(`${m.x},${m.y}`);
    });
    map.zones.forEach((z, i) => {
        const where = `구역 ${i + 1}(${z.x}, ${z.y})`;
        if (!ZONE_KINDS[z.kind]) add(`${where}: 모르는 종류 ${z.kind}`);
        if (z.width <= 0 || z.height <= 0) add(`${where}: 너비·높이는 1 이상이다`);
        if (z.x < 0 || z.y < 0 || z.x + z.width > map.size || z.y + z.height > map.size) add(`${where}: 맵 밖으로 나간다`);
    });
    return out;
}

// ── 편집 ───────────────────────────────────────────────────────────────

const snapshot = () => JSON.stringify({ size: state.map.size, cells: state.map.cells, markers: state.map.markers, zones: state.map.zones });

function remember() {
    state.undo.push(snapshot());
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
}

function restore(text) {
    const data = JSON.parse(text);
    Object.assign(state.map, data);
    changed();
}

function changed() {
    state.dirty = true;
    state.simCache = null;
    render();
}

function setStart(x, y, num) {
    const cell = state.map.cells[y]?.[x];
    if (cell && cell.start !== num) { cell.start = num; return true; }
    return false;
}

function markerAt(x, y) { return state.map.markers.findIndex((m) => m.x === x && m.y === y); }
function zoneAt(x, y) {
    for (let i = state.map.zones.length - 1; i >= 0; i--) {
        const z = state.map.zones[i];
        if (x >= z.x && y >= z.y && x < z.x + z.width && y < z.y + z.height) return i;
    }
    return -1;
}

function resize(size) {
    const old = state.map.cells;
    state.map.cells = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
        old[y]?.[x] ?? { start: state.brush, changes: [] }));
    state.map.size = size;
}

// ── 그리기 ───────────────────────────────────────────────────────────

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const cellPx = () => Number($('zoom').value);

function render() {
    const map = state.map;
    if (!map) return;
    const px = cellPx();
    canvas.width = map.size * px;
    canvas.height = map.size * px;
    ctx.imageSmoothingEnabled = false;

    let tiles = null;
    let sim = null;
    if (state.previewTick > 0) {
        state.simCache ??= {};
        sim = state.simCache[state.previewTick] ??= simulate(map, state.previewTick);
        tiles = sim.tiles;
    }
    for (let y = 0; y < map.size; y++) {
        for (let x = 0; x < map.size; x++) {
            const num = tiles ? tiles[y][x] : map.cells[y][x].start;
            const tile = state.tiles.get(num);
            if (tile?.img.complete) ctx.drawImage(tile.img, x * px, y * px, px, px);
            else { ctx.fillStyle = '#ff00ff'; ctx.fillRect(x * px, y * px, px, px); }
            if (!tiles && map.cells[y][x].changes.length) {
                ctx.fillStyle = '#e60012';
                ctx.fillRect(x * px + px - Math.max(3, px / 4), y * px, Math.max(3, px / 4), Math.max(3, px / 4));
            }
        }
    }
    if ($('show-grid').checked && px >= 8) {
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= map.size; i++) {
            ctx.moveTo(i * px + 0.5, 0); ctx.lineTo(i * px + 0.5, map.size * px);
            ctx.moveTo(0, i * px + 0.5); ctx.lineTo(map.size * px, i * px + 0.5);
        }
        ctx.stroke();
    }
    if (sim) {
        const inset = (sim.barrier / state.tileSize) * px;
        ctx.fillStyle = 'rgba(230,0,18,0.35)';
        const w = map.size * px;
        ctx.fillRect(0, 0, w, inset); ctx.fillRect(0, w - inset, w, inset);
        ctx.fillRect(0, inset, inset, w - 2 * inset); ctx.fillRect(w - inset, inset, inset, w - 2 * inset);
        ctx.strokeStyle = '#e60012'; ctx.lineWidth = 2;
        ctx.strokeRect(inset, inset, Math.max(0, w - 2 * inset), Math.max(0, w - 2 * inset));
    }
    if ($('show-layers').checked) {
        for (const z of map.zones) {
            const [label, color] = ZONE_KINDS[z.kind] ?? [z.kind, '#000'];
            ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
            ctx.strokeRect(z.x * px + 1.5, z.y * px + 1.5, z.width * px - 3, z.height * px - 3);
            ctx.setLineDash([]);
            drawLabel(label, z.x * px + 4, z.y * px + 4, color);
        }
        for (const m of map.markers) {
            const [label, color] = MARKER_KINDS[m.kind] ?? [m.kind, '#000'];
            ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc((m.x + 0.5) * px, (m.y + 0.5) * px, Math.max(4, px * 0.38), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            if (px >= 14) drawLabel(label, (m.x + 1) * px, m.y * px, color);
        }
    }
    if (state.previewPlayers > 0) {
        startPositions(map, state.previewPlayers).forEach(([x, y], i) => {
            ctx.fillStyle = '#1f1f1f'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc((x + 0.5) * px, (y + 0.5) * px, Math.max(5, px * 0.45), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(9, px * 0.5)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), (x + 0.5) * px, (y + 0.5) * px);
            ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        });
    }
    if (state.drag?.rect) {
        const r = normRect(state.drag.from, state.drag.to);
        ctx.strokeStyle = '#0a6fd6'; ctx.lineWidth = 2;
        ctx.strokeRect(r.x * px, r.y * px, r.width * px, r.height * px);
    }
    if (state.selected) {
        ctx.strokeStyle = '#e60012'; ctx.lineWidth = 3;
        ctx.strokeRect(state.selected.x * px + 1.5, state.selected.y * px + 1.5, px - 3, px - 3);
    }
    renderProblems();
    renderInspector();
}

function drawLabel(text, x, y, color) {
    ctx.font = '12px system-ui';
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, 16);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 15);
    ctx.fillStyle = '#1f1f1f'; ctx.fillText(text, x + 4, y + 12);
}

function renderProblems() {
    const list = problems(state.map);
    $('problem-count').textContent = list.length ? `(${list.length})` : '';
    $('problems').replaceChildren(...(list.length ? list.slice(0, 50).map((text) => {
        const li = document.createElement('li'); li.className = 'error'; li.textContent = text; return li;
    }) : [Object.assign(document.createElement('li'), { className: 'ok', textContent: '✓ 빌드할 수 있다' })]));
    $('build').disabled = list.length > 0;
}

function renderInspector() {
    const box = $('inspector');
    if (!state.selected || state.tool !== 'cell') return;
    const { x, y } = state.selected;
    const cell = state.map.cells[y]?.[x];
    if (!cell) return;
    if (box.dataset.key === `${x},${y}` && box.contains(document.activeElement)) return;
    box.dataset.key = `${x},${y}`;
    box.innerHTML = '';
    const title = document.createElement('p');
    title.textContent = `(${x}, ${y}) 시작 타일: ${state.tiles.get(cell.start)?.name ?? cell.start}`;
    const help = document.createElement('p');
    help.className = 'muted';
    help.textContent = '한 줄에 하나씩 "틱:타일번호". 틱이 되면 그 타일로 바뀐다. "*:타일번호"는 자기장이 이 칸(벽·연막)에 닿았을 때 바뀔 타일이다. 60틱 = 1초.';
    const area = document.createElement('textarea');
    area.rows = 6;
    area.value = cell.changes.map(([tick, tile]) => `${tick}:${tile}`).join('\n');
    const apply = document.createElement('button');
    apply.textContent = '적용';
    apply.onclick = () => {
        remember();
        cell.changes = area.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
            const [tick, tile] = line.split(':').map((s) => s.trim());
            return [tick === '*' ? '*' : Number(tick), Number(tile)];
        });
        box.dataset.key = '';
        changed();
    };
    box.append(title, help, area, apply);
}

// ── 입력 ───────────────────────────────────────────────────────────────

function cellFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const px = cellPx();
    const x = Math.floor(((event.clientX - rect.left) * (canvas.width / rect.width)) / px);
    const y = Math.floor(((event.clientY - rect.top) * (canvas.height / rect.height)) / px);
    return x >= 0 && y >= 0 && x < state.map.size && y < state.map.size ? { x, y } : null;
}
const normRect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 1, height: Math.abs(a.y - b.y) + 1 });

canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('mousedown', (event) => {
    if (!state.map) return;
    const at = cellFromEvent(event);
    if (!at) return;
    const right = event.button === 2;
    if (state.tool === 'pick' || (right && ['brush', 'rect'].includes(state.tool))) {
        state.brush = state.map.cells[at.y][at.x].start; renderTiles(); return;
    }
    if (state.tool === 'cell') { state.selected = at; render(); return; }
    if (state.tool === 'marker') {
        const index = markerAt(at.x, at.y);
        remember();
        if (right) { if (index >= 0) state.map.markers.splice(index, 1); }
        else if (index >= 0) state.map.markers[index].kind = state.markerKind;
        else state.map.markers.push({ kind: state.markerKind, x: at.x, y: at.y });
        changed(); return;
    }
    if (state.tool === 'zone' && right) {
        const index = zoneAt(at.x, at.y);
        if (index >= 0) { remember(); state.map.zones.splice(index, 1); changed(); }
        return;
    }
    remember();
    state.drag = { from: at, to: at, rect: state.tool === 'rect' || state.tool === 'zone' };
    if (state.tool === 'brush' && setStart(at.x, at.y, state.brush)) changed();
});
canvas.addEventListener('mousemove', (event) => {
    if (!state.map) return;
    const at = cellFromEvent(event);
    if (at) {
        const cell = state.map.cells[at.y][at.x];
        const marker = state.map.markers[markerAt(at.x, at.y)];
        $('hover').textContent = `(${at.x}, ${at.y}) ${state.tiles.get(cell.start)?.name ?? cell.start}${cell.changes.length ? ` · 시간표 ${formatCell(cell)}` : ''}${marker ? ` · ${MARKER_KINDS[marker.kind]?.[0] ?? marker.kind}` : ''}`;
    }
    if (!state.drag || !at) return;
    state.drag.to = at;
    if (state.tool === 'brush') { if (setStart(at.x, at.y, state.brush)) changed(); }
    else render();
});
window.addEventListener('mouseup', () => {
    const drag = state.drag;
    state.drag = null;
    if (!drag || !drag.rect) return;
    const r = normRect(drag.from, drag.to);
    if (state.tool === 'rect') {
        for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) setStart(x, y, state.brush);
    } else if (state.tool === 'zone') {
        state.map.zones.push({ kind: state.zoneKind, ...r });
    }
    changed();
});

window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); save(); return; }
    if ((event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey))) { event.preventDefault(); redo(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); undo(); return; }
    const tool = TOOLS.find(([, , shortcut]) => shortcut.toLowerCase() === key);
    if (tool) setTool(tool[0]);
});

function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
}
function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
}

// ── 패널 ───────────────────────────────────────────────────────────────

function setTool(tool) {
    state.tool = tool;
    for (const button of $('tools').children) button.classList.toggle('active', button.dataset.tool === tool);
    const options = $('tool-options');
    options.innerHTML = '';
    if (tool === 'marker' || tool === 'zone') {
        const kinds = tool === 'marker' ? MARKER_KINDS : ZONE_KINDS;
        const select = document.createElement('select');
        select.setAttribute('aria-label', tool === 'marker' ? '마커 종류' : '구역 종류');
        for (const [kind, [label]] of Object.entries(kinds)) select.append(new Option(`${label} (${kind})`, kind));
        select.value = tool === 'marker' ? state.markerKind : state.zoneKind;
        select.onchange = () => { if (tool === 'marker') state.markerKind = select.value; else state.zoneKind = select.value; };
        const help = document.createElement('p');
        help.className = 'muted';
        help.textContent = tool === 'marker' ? '왼쪽 클릭: 놓기(있으면 종류 바꾸기) · 오른쪽 클릭: 지우기' : '끌어서 구역 만들기 · 오른쪽 클릭: 지우기';
        options.append(select, help);
    } else {
        const help = document.createElement('p');
        help.className = 'muted';
        help.textContent = {
            brush: '끌어서 칠하기 · 오른쪽 클릭: 그 칸의 타일 집기',
            rect: '끌어서 사각형 채우기 · 오른쪽 클릭: 타일 집기',
            pick: '누른 칸의 타일을 브러시로 집는다',
            cell: '칸을 누르면 오른쪽에서 시간표(틱마다 바뀌는 타일)를 고친다. 빨간 점은 시간표가 있는 칸.',
        }[tool];
        options.append(help);
        if (tool !== 'cell') $('inspector').innerHTML = '<p class="muted">"칸" 도구로 칸을 누르면 그 칸의 시간표를 고칠 수 있다.</p>';
    }
    render();
}

function renderTiles() {
    for (const button of $('tiles').children) button.classList.toggle('active', Number(button.dataset.num) === state.brush);
}

function renderProps() {
    const map = state.map;
    $('prop-name').value = map.name;
    $('prop-file').value = map.file;
    $('prop-size').value = map.size;
    $('prop-barrier').value = map.barrier;
    $('prop-training').checked = map.training;
    const end = Math.ceil((map.size * state.tileSize / 2) / Math.max(1, map.barrier));
    $('preview-tick').max = String(end);
    $('preview-tick').value = String(Math.min(state.previewTick, end));
}

function status(text, kind = '') {
    $('status').textContent = text;
    $('status').className = kind;
}

// ── 서버 ───────────────────────────────────────────────────────────────

async function api(path, options) {
    const response = await fetch(path, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    return body;
}

async function loadList(select) {
    const maps = await api('/api/maps');
    const box = $('map-select');
    box.replaceChildren(...maps.map((m) => new Option(`${m.name} (${m.file}, ${m.size}×${m.size}${m.training ? ', 훈련장' : ''})`, m.file)));
    if (select) box.value = select;
}

async function openMap(file) {
    if (state.dirty && !confirm('저장하지 않은 변경이 있다. 버리고 다른 맵을 열까?')) { $('map-select').value = state.map.file; return; }
    const { json, csv } = await api(`/api/maps/${encodeURIComponent(file)}`);
    state.map = parseMap(file, json, csv);
    state.undo = []; state.redo = []; state.selected = null; state.dirty = false; state.simCache = null; state.previewTick = 0;
    renderProps();
    render();
    status(`${json.name}을 열었다`);
}

async function save() {
    if (!state.map) return false;
    try {
        await api(`/api/maps/${encodeURIComponent(state.map.file)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(serializeMap(state.map)) });
        state.dirty = false;
        await loadList(state.map.file);
        status('저장했다', 'ok');
        return true;
    } catch (error) {
        status(`저장 실패: ${error.message}`, 'error');
        return false;
    }
}

async function build() {
    if (state.dirty && !(await save())) return;
    status('빌드 중… (몇 초~몇십 초)');
    $('build').disabled = true;
    try {
        const result = await api('/api/build', { method: 'POST' });
        $('build-log').textContent = result.log;
        status(result.ok
            ? (result.changed ? '빌드했다. server-game/maps/server_maps.json이 바뀌었다 — 함께 커밋한다' : '빌드했다. 번들은 바뀌지 않았다')
            : '빌드 실패 — 오른쪽 아래 기록을 본다', result.ok ? 'ok' : 'error');
    } catch (error) {
        status(`빌드 실패: ${error.message}`, 'error');
    } finally {
        renderProblems();
    }
}

// ── 시작 ───────────────────────────────────────────────────────────────

async function start() {
    state.setting = await api('/api/setting');
    state.tileSize = state.setting.tile_size ?? 256;
    for (const tile of state.setting.tile_data) {
        const img = new Image();
        img.src = `/asset/${tile.file}`;
        img.onload = () => render();
        state.tiles.set(tile.num, { ...tile, img });
        const button = document.createElement('button');
        button.className = 'tile';
        button.dataset.num = tile.num;
        button.title = `번호 ${tile.num}, physics ${tile.physics}`;
        const icon = document.createElement('img');
        icon.src = img.src;
        icon.alt = '';
        button.append(icon, `${tile.num} ${tile.name}`);
        button.onclick = () => { state.brush = tile.num; renderTiles(); if (!['brush', 'rect'].includes(state.tool)) setTool('brush'); };
        $('tiles').append(button);
    }
    for (const [tool, label, key] of TOOLS) {
        const button = document.createElement('button');
        button.dataset.tool = tool;
        button.textContent = `${label} ${key}`;
        button.onclick = () => setTool(tool);
        $('tools').append(button);
    }
    renderTiles();

    $('map-select').onchange = (event) => openMap(event.target.value);
    $('save').onclick = save;
    $('build').onclick = build;
    $('zoom').oninput = render;
    $('show-grid').onchange = render;
    $('show-layers').onchange = render;
    $('preview-tick').oninput = (event) => {
        state.previewTick = Number(event.target.value);
        const seconds = (state.previewTick / 60).toFixed(1);
        $('preview-label').textContent = `${state.previewTick}틱 (${seconds}초)`;
        render();
    };
    $('preview-players').onchange = (event) => { state.previewPlayers = Number(event.target.value); render(); };
    $('prop-name').onchange = (event) => { state.map.name = event.target.value.trim(); changed(); };
    $('prop-barrier').onchange = (event) => { state.map.barrier = Number(event.target.value); renderProps(); changed(); };
    $('prop-training').onchange = (event) => { state.map.training = event.target.checked; changed(); };
    $('prop-size').onchange = (event) => {
        const size = Number(event.target.value);
        if (!Number.isInteger(size) || size < 10 || size > 120) { renderProps(); return; }
        remember(); resize(size); renderProps(); changed();
    };
    $('new-map').onclick = () => $('new-dialog').showModal();
    $('new-dialog').addEventListener('close', () => {
        const dialog = $('new-dialog');
        if (dialog.returnValue !== 'ok') return;
        const form = new FormData(dialog.querySelector('form'));
        const size = Number(form.get('size'));
        const file = String(form.get('file'));
        const cells = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
            ({ start: x === 0 || y === 0 || x === size - 1 || y === size - 1 ? 0 : 1, changes: [] })));
        state.map = { file, name: String(form.get('name')), size, barrier: 1, training: false, markers: [], zones: [], cells };
        state.undo = []; state.redo = []; state.selected = null; state.dirty = true; state.simCache = null; state.previewTick = 0;
        renderProps();
        render();
        status('새 맵이다. 저장하면 map/에 파일이 생긴다');
    });
    window.addEventListener('beforeunload', (event) => { if (state.dirty) event.preventDefault(); });

    setTool('brush');
    await loadList();
    if ($('map-select').value) await openMap($('map-select').value);
}

start().catch((error) => status(`시작 실패: ${error.message}`, 'error'));
