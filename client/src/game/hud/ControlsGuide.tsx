import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../types.ts';
import { Color } from '../../theme/color.ts';
import { HUD_DISPLAY_FONT, HUD_FONT, HUD_METRICS, bodyText, mutedText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    movementSkillLabel: string | null;
}

const Key: React.FC<{ theme: Theme; children: React.ReactNode }> = ({ theme, children }) => (
    <span style={{
        display: 'inline-block', minWidth: 24, padding: '4px 8px', borderRadius: 8,
        border: `2px solid ${Color.smoke[2]}`,
        background: theme === 1 ? Color.black : Color.white,
        color: bodyText(theme), fontSize: HUD_METRICS.captionFont, fontWeight: 800, textAlign: 'center',
    }}>{children}</span>
);

/**
 * Keybind reference for help mode. In-game the bindings are printed on the skill slots, but switch and
 * emoji are bound to number keys with no button of their own, so without this there's nowhere to learn
 * them — legacy had exactly this problem (its only hint was a code comment in the keymap).
 */
export const ControlsGuide: React.FC<Props> = ({ theme, movementSkillLabel }) => {
    const { t } = useTranslation();
    const rows: [React.ReactNode, string][] = [
        [<><Key theme={theme}>W</Key> <Key theme={theme}>A</Key> <Key theme={theme}>S</Key> <Key theme={theme}>D</Key></>, t('game.hud.controls.move')],
        [<Key theme={theme}>Space</Key>, movementSkillLabel ? t('game.hud.controls.useSkill', { skill: movementSkillLabel }) : t('game.hud.controls.movementSkill')],
        [<><Key theme={theme}>1</Key> ~ <Key theme={theme}>8</Key></>, t('game.hud.controls.switch')],
        [<><Key theme={theme}>Shift</Key> + <Key theme={theme}>1</Key>~<Key theme={theme}>8</Key></>, t('game.hud.controls.emoji')],
        [<><Key theme={theme}>{t('game.hud.controls.wheel')}</Key> / <Key theme={theme}>{t('game.hud.controls.drag')}</Key></>, t('game.hud.controls.camera')],
    ];

    return (
        <div style={{
            ...panel(theme), position: 'absolute', left: HUD_METRICS.corner, bottom: HUD_METRICS.corner,
            padding: 18, minWidth: 360,
            fontFamily: HUD_FONT,
        }}>
            <div style={{ color: mutedText(theme), fontFamily: HUD_DISPLAY_FONT, fontSize: 18, fontWeight: 400, letterSpacing: 0.5, paddingBottom: 13 }}>{t('game.hud.controls.title')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {rows.map(([keys, desc], i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <span style={{ flex: 'none', minWidth: 146 }}>{keys}</span>
                        <span style={{ color: bodyText(theme), fontSize: HUD_METRICS.bodyFont, fontWeight: 600 }}>{desc}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};
