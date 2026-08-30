import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    BGM_TRACK,
    cancelBgmDownload,
    discardBgm,
    downloadBgm,
    playBgm,
    stopBgm,
    useBgmState,
} from '../../audio';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';

/**
 * 사운드 설정의 BGM 카드. 이 화면이 유일하게 1MB를 내려받는 곳이다.
 *
 * "켜기"가 곧 "받기"인 이유는, 그렇지 않으면 사용자가 아무것도 안 했는데 접속만으로
 * 데이터를 쓰게 되기 때문이다. 몇 KB 단위로 관리하는 요금제를 쓰는 사람이 여전히 있다.
 * 대신 한 번 받으면 다시 안 받는다는 것과, 지울 수 있다는 것을 같은 카드 안에서 말해 준다.
 */
const formatBytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

const formatDuration = (seconds: number): string => {
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const BgmCard: React.FC = () => {
    const { t } = useTranslation();
    const bgm = useBgmState();
    const enabled = useSettingsStore((state) => state.bgmEnabled);
    const setBgmEnabled = useSettingsStore((state) => state.setBgmEnabled);

    const downloaded = bgm.status === 'ready' || bgm.status === 'playing';

    const enable = async () => {
        setBgmEnabled(true);
        if (!downloaded && !(await downloadBgm())) return;
        void playBgm();
    };

    const disable = () => {
        setBgmEnabled(false);
        cancelBgmDownload();
        stopBgm();
    };

    // 지우는 것은 끄는 것을 포함한다. 파일이 없는데 "켜짐"으로 남아 있으면 다음 접속에
    // 조용히 아무 일도 안 일어나고, 사용자는 무엇이 고장났는지 알 길이 없다.
    const remove = async () => {
        setBgmEnabled(false);
        await discardBgm();
    };

    // 켜 뒀는데 파일이 없는 상태가 실제로 생긴다 — 곡을 교체하면 파일 이름의 해시가 바뀌어서
    // 예전에 받아 둔 것이 더 이상 이 곡이 아니게 된다. 그때 저절로 1MB를 다시 받아 버리면
    // 사용자가 아무것도 안 했는데 데이터를 쓰는 셈이라, 다시 누를 자리를 준다.
    const staleAfterTrackChange = enabled && bgm.status === 'absent';

    const statusLine = bgm.unsupported
        ? t('settings.sound.bgmUnsupported')
        : bgm.status === 'error'
            ? t('settings.sound.bgmError')
            : bgm.status === 'downloading'
                ? t('settings.sound.bgmDownloading', { percent: Math.round(bgm.progress * 100) })
                : downloaded
                    ? (bgm.persisted ? t('settings.sound.bgmStored') : t('settings.sound.bgmStoredVolatile'))
                    : staleAfterTrackChange
                        ? t('settings.sound.bgmChanged', { size: formatBytes(bgm.bytes) })
                        : t('settings.sound.bgmNotDownloaded', { size: formatBytes(bgm.bytes) });

    return (
        <div className="settings-now-playing">
            <div className="settings-album-art" aria-hidden="true"><span>♪</span></div>
            <div>
                <span className="settings-card-kicker">{t('settings.sound.bgmInfo')}</span>
                <strong>{t('settings.sound.trackTitle')}</strong>
                <p>{t('settings.sound.trackArtist')} · {formatDuration(BGM_TRACK.durationSec)}</p>
                <small aria-live="polite">{statusLine}</small>
                {bgm.status === 'downloading' && (
                    <div
                        className="settings-bgm-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(bgm.progress * 100)}
                    >
                        <span style={{ width: `${Math.round(bgm.progress * 100)}%` }} />
                    </div>
                )}
                <div className="settings-bgm-actions">
                    {/* 주 버튼은 켜짐/꺼짐이 아니라 "지금 할 수 있는 일"을 따른다.
                        켜져 있는데 파일이 없으면 끄기만 남아 다시 받을 길이 없어지기 때문이다. */}
                    {bgm.status === 'downloading' ? (
                        <button type="button" className="settings-reset" onClick={disable}>
                            {t('settings.sound.bgmCancel')}
                        </button>
                    ) : !downloaded ? (
                        <button type="button" className="settings-reset" disabled={bgm.unsupported} onClick={() => void enable()}>
                            {t('settings.sound.bgmDownload', { size: formatBytes(bgm.bytes) })}
                        </button>
                    ) : enabled ? (
                        <button type="button" className="settings-reset" onClick={disable}>
                            {t('settings.sound.bgmOff')}
                        </button>
                    ) : (
                        <button type="button" className="settings-reset" onClick={() => void enable()}>
                            {t('settings.sound.bgmOn')}
                        </button>
                    )}
                    {downloaded && (
                        <button type="button" className="settings-reset" onClick={() => void remove()}>
                            {t('settings.sound.bgmDelete')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
