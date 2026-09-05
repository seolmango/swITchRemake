import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';
import {
    ASSET_CREDITS,
    OPERATOR_CREDIT,
    type LegalDocument,
} from '../../legal/legalDocuments.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { useModalFocusTrap } from '../common/useModalFocusTrap.ts';

interface DialogFrameProps {
    labelledBy: string;
    onClose: () => void;
    children: React.ReactNode;
}

const DialogFrame: React.FC<DialogFrameProps> = ({ labelledBy, onClose, children }) => {
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLElement>(onClose);

    return createPortal(
        <div
            className="legal-dialog-backdrop"
            role="presentation"
            style={{
                '--legal-panel': colors.panel,
                '--legal-border': colors.panelBorder,
                '--legal-field': colors.field,
                '--legal-text': colors.text,
                '--legal-muted': colors.muted,
                '--legal-accent': theme === 0 ? Color.blue[1] : Color.blue[2],
                '--legal-backdrop': colors.backdrop,
            } as React.CSSProperties}
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
            <section
                ref={dialogRef}
                className="legal-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelledBy}
                tabIndex={-1}
                onKeyDown={onDialogKeyDown}
            >
                {children}
                <button type="button" className="legal-dialog-close" autoFocus onClick={onClose}>{t('legal.close')}</button>
            </section>
        </div>
        , document.body,
    );
};

export const LegalDocumentDialog: React.FC<{
    document: LegalDocument;
    onClose: () => void;
}> = ({ document, onClose }) => {
    const { t } = useTranslation();
    const titleId = `legal-${document.kind}-title`;
    return (
        <DialogFrame labelledBy={titleId} onClose={onClose}>
            <header className="legal-dialog-header">
                <div>
                    <span>{t('legal.document')}</span>
                    <h2 id={titleId}>{t(`legal.${document.kind}`)}</h2>
                </div>
                <strong>{t('legal.version', { version: document.version })}</strong>
            </header>
            <MarkdownDocument source={document.source}/>
        </DialogFrame>
    );
};

export const CreditsDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { t } = useTranslation();
    return (
        <DialogFrame labelledBy="credits-dialog-title" onClose={onClose}>
            <header className="legal-dialog-header">
                <div>
                    <span>swITch</span>
                    <h2 id="credits-dialog-title">{t('legal.credits')}</h2>
                </div>
            </header>
            <div className="credits-dialog-content">
                <section>
                    <h3>{t('legal.operator')}</h3>
                    <dl>
                        <div><dt>{t('legal.name')}</dt><dd>{OPERATOR_CREDIT.name}</dd></div>
                        <div><dt>{t('legal.contact')}</dt><dd><a href={`mailto:${OPERATOR_CREDIT.contact}`}>{OPERATOR_CREDIT.contact}</a></dd></div>
                        <div><dt>{t('legal.repository')}</dt><dd><a href={OPERATOR_CREDIT.repository} target="_blank" rel="noreferrer">{OPERATOR_CREDIT.repository}</a></dd></div>
                    </dl>
                </section>
                <section className="credits-assets" aria-labelledby="credits-assets-title">
                    <h3 id="credits-assets-title">{t('legal.assets')}</h3>
                    <ul>
                        {ASSET_CREDITS.map((asset) => (
                            <li key={`${asset.name}:${asset.source}`}>
                                <strong>{asset.name}</strong>
                                <span>{asset.source}</span>
                                <span>{asset.license}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            </div>
        </DialogFrame>
    );
};
