import React from 'react';
import type { Theme } from '../types.ts';
import { HUD_FONT, bodyText, mutedText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    movementSkillLabel: string | null;
}

const Key: React.FC<{ theme: Theme; children: React.ReactNode }> = ({ theme, children }) => (
    <span style={{
        display: 'inline-block', minWidth: 20, padding: '2px 7px', borderRadius: 6,
        border: `1.5px solid ${theme === 1 ? '#5A5E60' : '#CFCFCB'}`,
        background: theme === 1 ? '#2E3132' : '#FFFFFF',
        color: bodyText(theme), fontSize: 11, fontWeight: 800, textAlign: 'center',
    }}>{children}</span>
);

/**
 * Keybind reference for help mode. In-game the bindings are printed on the skill slots, but switch and
 * emoji are bound to number keys with no button of their own, so without this there's nowhere to learn
 * them — legacy had exactly this problem (its only hint was a code comment in the keymap).
 */
export const ControlsGuide: React.FC<Props> = ({ theme, movementSkillLabel }) => {
    const rows: [React.ReactNode, string][] = [
        [<><Key theme={theme}>W</Key> <Key theme={theme}>A</Key> <Key theme={theme}>S</Key> <Key theme={theme}>D</Key></>, '이동 (방향키도 가능)'],
        [<Key theme={theme}>Space</Key>, movementSkillLabel ? `${movementSkillLabel} 사용` : '이동 스킬'],
        [<><Key theme={theme}>1</Key> ~ <Key theme={theme}>8</Key></>, '해당 번호 플레이어와 스위치'],
        [<><Key theme={theme}>Shift</Key> + <Key theme={theme}>1</Key>~<Key theme={theme}>8</Key></>, '이모지 (Shift를 누르고 있으면 목록)'],
        [<><Key theme={theme}>휠</Key> / <Key theme={theme}>드래그</Key></>, '줌 / 시점 이동 (자유시점)'],
    ];

    return (
        <div style={{
            ...panel(theme), position: 'absolute', left: 16, bottom: 16, padding: 14, minWidth: 260,
            fontFamily: HUD_FONT,
        }}>
            <div style={{ color: mutedText(theme), fontSize: 11, fontWeight: 800, letterSpacing: 0.5, paddingBottom: 10 }}>조작</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {rows.map(([keys, desc], i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ flex: 'none', minWidth: 116 }}>{keys}</span>
                        <span style={{ color: bodyText(theme), fontSize: 12, fontWeight: 600 }}>{desc}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};
