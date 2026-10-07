import { expect } from '@playwright/test';

/**
 * 인증 코드를 읽는 곳.
 *
 * 검증 스택의 매칭 서버는 실제 SMTP로 메일을 보내고, 그 SMTP는 스택 안의 Mailpit이다. 점검은 Mailpit
 * API로 받은편지함을 읽는다 — 실제 메일 경로(SMTP 전송, 제목, 본문 렌더링)를 그대로 지난다.
 * **외부로 나가는 메일은 0건이다.** 스택 네트워크는 바깥으로 길이 없다.
 */

const MAILPIT = process.env.AUDIT_MAIL_URL ?? 'http://mailpit:8025';

/** 서버의 `VerificationPurpose`와 같은 문자열. */
export type MailPurpose =
    | 'signup'
    | 'reset-password'
    | 'delete'
    | 'mfa-login'
    | 'mfa-step-up'
    | 'mfa-reset-password';

/** 용도별 메일 제목의 일부(server-match/src/email/email.service.ts). 2차 인증 세 용도는 제목이 같다. */
const SUBJECT: Record<MailPurpose, string> = {
    signup: '회원가입',
    'reset-password': '비밀번호 재설정',
    delete: '회원 탈퇴',
    'mfa-login': '2차 인증',
    'mfa-step-up': '2차 인증',
    'mfa-reset-password': '2차 인증',
};

export interface ReceivedMail {
    id: string;
    subject: string;
    code: string;
    sentAt: string;
}

interface MailpitSummary { ID: string; Subject?: string; Created?: string }

async function search(email: string): Promise<MailpitSummary[]> {
    const response = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (!response.ok) return [];
    const data = await response.json() as { messages?: MailpitSummary[] };
    return data.messages ?? []; // 최신 메일이 앞에 온다
}

async function read(summary: MailpitSummary): Promise<ReceivedMail | null> {
    const response = await fetch(`${MAILPIT}/api/v1/message/${summary.ID}`);
    if (!response.ok) return null;
    const data = await response.json() as { Text?: string; HTML?: string };
    const code = `${data.Text ?? ''}\n${data.HTML ?? ''}`.match(/\b\d{6}\b/)?.[0];
    return code ? { id: summary.ID, subject: summary.Subject ?? '', code, sentAt: summary.Created ?? new Date().toISOString() } : null;
}

/**
 * 제목에 `subject`가 들어간, `excluded`에 없는 가장 최근 메일을 기다린다.
 * 같은 주소로 여러 번 받는 흐름은 앞서 쓴 메일 id를 `excluded`에 넣어 새 메일만 집는다.
 */
export async function latestMail(email: string, subject: string, excluded: ReadonlySet<string> = new Set(), timeoutMs = 15_000): Promise<ReceivedMail> {
    let found: ReceivedMail | null = null;
    await expect.poll(async () => {
        const summary = (await search(email)).find((message) => message.Subject?.includes(subject) && !excluded.has(message.ID));
        found = summary ? await read(summary) : null;
        return found !== null;
    }, { timeout: timeoutMs, message: `${email} 앞으로 온 "${subject}" 메일` }).toBe(true);
    return found!;
}

/** 이 주소로 온 그 용도의 마지막 메일. 보내기 전에 `clearMail`로 비워 두면 새 메일만 남는다. */
export async function waitForMail(email: string, purpose: MailPurpose, timeoutMs = 15_000): Promise<ReceivedMail> {
    return latestMail(email, SUBJECT[purpose], new Set(), timeoutMs);
}

/** 앞선 흐름이 남긴 코드를 새 코드로 오인하지 않게 지운다. 용도를 주면 그 용도의 메일만 지운다. */
export async function clearMail(email: string, purpose?: MailPurpose): Promise<void> {
    const ids = (await search(email))
        .filter((message) => purpose === undefined || message.Subject?.includes(SUBJECT[purpose]))
        .map((message) => message.ID);
    if (ids.length === 0) return;
    await fetch(`${MAILPIT}/api/v1/messages`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ IDs: ids }),
    });
}

/**
 * 같은 주소·같은 용도의 인증 메일은 60초에 한 번만 나간다(BASE.md §9의 "아주 좁게" 등급).
 * 한 흐름에서 같은 용도의 메일을 두 번 받아야 하면 그 창이 지나기를 기다린다 — 안 기다리면 두 번째
 * 요청이 조용히 발송되지 않고 화면에는 "코드를 보냈다"만 뜬다.
 */
export const MAIL_REISSUE_WINDOW_MS = 60_000;

export function mailCooldownRemainingMs(previous: ReceivedMail, now = Date.now()): number {
    return Math.max(0, new Date(previous.sentAt).getTime() + MAIL_REISSUE_WINDOW_MS - now);
}

export async function waitForMailReissue(previous: ReceivedMail): Promise<void> {
    const remaining = mailCooldownRemainingMs(previous);
    if (remaining > 0) await new Promise((done) => setTimeout(done, remaining + 250));
}
