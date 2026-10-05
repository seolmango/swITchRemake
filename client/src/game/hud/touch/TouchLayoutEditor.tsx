import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    TOUCH_ELEMENTS,
    TOUCH_SCALE_RANGE,
    useSettingsStore,
    type TouchElement,
} from '../../../stores/useSettingsStore.ts';
import { ROTATED_STYLE, shouldForceLandscape } from '../../../components/layout/forcedLandscape.ts';
import { useModalFocusTrap } from '../../../components/common/useModalFocusTrap.ts';
import { useSkillIcons } from '../../../theme/skillIcons.ts';
import { anchorFromPoint, placeElement } from './touchLayout.ts';

/**
 * 조이스틱 배치 편집기. 실제 게임 화면처럼 화면 전체를 쓰고, 폰을 세워 들었으면 게임처럼 가로로
 * 돌려 그린다. 네 요소를 끌어 옮기고, 고른 요소의 크기를 바꾼다.
 *
 * 자리는 인게임 조작과 **같은 `placeElement`**로 계산한다. 축소한 미리보기 판을 쓰던 예전 방식은
 * 손가락 크기 감각이 맞지 않았다 — 여기서는 실제 크기 그대로 보고 실제 엄지로 대 본다.
 */
export const TouchLayoutEditor: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { t } = useTranslation();
    const layout = useSettingsStore((state) => state.touchLayout);
    const theme = useSettingsStore((state) => state.theme);
    const setTouchElement = useSettingsStore((state) => state.setTouchElement);
    const resetTouchLayout = useSettingsStore((state) => state.resetTouchLayout);
    const icons = useSkillIcons();
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLDivElement>(onClose);
    const [selected, setSelected] = useState<TouchElement>('action');
    const [screen, setScreen] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const drag = useRef<{ element: TouchElement; dx: number; dy: number; pointerId: number } | null>(null);

    useEffect(() => {
        const update = () => setScreen({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);

    const rotated = shouldForceLandscape(screen.width, screen.height);
    const viewport = rotated ? { width: screen.height, height: screen.width } : screen;

    /** 화면 좌표를 편집 화면(돌렸으면 돌린 기준) 좌표로. 시계 방향 90°의 역변환이다. */
    const toContent = useCallback((clientX: number, clientY: number) => (rotated
        ? { x: clientY, y: screen.width - clientX }
        : { x: clientX, y: clientY }), [rotated, screen.width]);

    const begin = (element: TouchElement) => (event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        setSelected(element);
        const place = placeElement(element, layout, viewport);
        const point = toContent(event.clientX, event.clientY);
        drag.current = { element, dx: point.x - place.x, dy: point.y - place.y, pointerId: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const move = (event: React.PointerEvent<HTMLButtonElement>) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const point = toContent(event.clientX, event.clientY);
        setTouchElement(active.element, anchorFromPoint({ x: point.x - active.dx, y: point.y - active.dy }, viewport));
    };

    const end = () => { drag.current = null; };

    const nudge = (element: TouchElement, dx: number, dy: number) => {
        const current = layout[element];
        setTouchElement(element, { x: current.x + dx, y: current.y + dy });
    };

    const onElementKey = (element: TouchElement) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const step = event.shiftKey ? 0.05 : 0.01;
        const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (moves[event.key]) {
            event.preventDefault();
            nudge(element, ...moves[event.key]!);
        } else if (event.key === '+' || event.key === '=') {
            setTouchElement(element, { scale: layout[element].scale + 0.05 });
        } else if (event.key === '-') {
            setTouchElement(element, { scale: layout[element].scale - 0.05 });
        }
    };

    const names: Record<TouchElement, string> = {
        move: t('settings.controls.elements.move'),
        action: t('settings.controls.elements.action'),
        skill: t('settings.controls.elements.skill'),
        mode: t('settings.controls.elements.mode'),
    };
    const scalePercent = Math.round(layout[selected].scale * 100);

    return createPortal(
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('settings.controls.editorTitle')}
            tabIndex={-1}
            onKeyDown={onDialogKeyDown}
            className={`touch-editor${theme === 1 ? ' is-dark' : ''}`}
            style={rotated ? { ...ROTATED_STYLE, zIndex: 1100 } : { position: 'fixed', inset: 0, zIndex: 1100 }}
        >
            <div className="touch-editor-toolbar">
                <strong>{t('settings.controls.editorTitle')}</strong>
                <span className="touch-editor-selected">{names[selected]}</span>
                <label className="touch-editor-size">
                    <span>{t('settings.controls.size')}</span>
                    <button type="button" className="ui-button" aria-label={`${names[selected]} ${t('settings.controls.smaller')}`}
                        onClick={() => setTouchElement(selected, { scale: layout[selected].scale - 0.05 })}>−</button>
                    <input
                        type="range"
                        min={TOUCH_SCALE_RANGE.min * 100}
                        max={TOUCH_SCALE_RANGE.max * 100}
                        step={5}
                        value={scalePercent}
                        aria-label={`${names[selected]} ${t('settings.controls.size')}`}
                        onChange={(event) => setTouchElement(selected, { scale: Number(event.target.value) / 100 })}
                    />
                    <button type="button" className="ui-button" aria-label={`${names[selected]} ${t('settings.controls.larger')}`}
                        onClick={() => setTouchElement(selected, { scale: layout[selected].scale + 0.05 })}>+</button>
                    <output>{scalePercent}%</output>
                </label>
                <button type="button" className="ui-button is-quiet" onClick={resetTouchLayout}>{t('settings.controls.resetLayout')}</button>
                <button type="button" className="ui-button is-primary" onClick={onClose}>{t('settings.controls.done')}</button>
            </div>
            <p className="touch-editor-hint">{t('settings.controls.editorHint')}</p>

            {TOUCH_ELEMENTS.map((element) => {
                const place = placeElement(element, layout, viewport);
                return (
                    <button
                        key={element}
                        type="button"
                        className={`touch-editor-element is-${element}${selected === element ? ' is-selected' : ''}`}
                        aria-label={`${names[element]} · ${Math.round(place.scale * 100)}%`}
                        aria-pressed={selected === element}
                        onPointerDown={begin(element)}
                        onPointerMove={move}
                        onPointerUp={end}
                        onPointerCancel={end}
                        onFocus={() => setSelected(element)}
                        onKeyDown={onElementKey(element)}
                        style={{ left: place.x, top: place.y, width: place.width, height: place.height }}
                    >
                        {element === 'skill' && <img src={icons.dash} alt=""/>}
                        {element === 'mode' && <><span>{t('game.hud.touch.switch')}</span><span>{t('game.hud.touch.emoji')}</span></>}
                        {(element === 'move' || element === 'action') && <i aria-hidden="true"/>}
                        <small>{names[element]}</small>
                    </button>
                );
            })}
        </div>,
        document.body,
    );
};
