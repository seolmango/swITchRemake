import Redis from 'ioredis';

/**
 * 인증 코드를 읽는 곳.
 *
 * `EMAIL_TRANSPORT=sink`면 매칭 서버가 메일을 보내는 대신 Redis `test:mail:{email}`에
 * 코드를 남긴다. 점검은 그것만 읽는다 — **실제 발송은 0건이다.** 진짜 메일함을 뒤지는
 * 방식은 느리고, 남의 받은편지함을 점검이 어지럽힌다.
 */

let client: Redis | null = null;

const redis = (): Redis => {
    if (client === null) {
        client = new Redis({
            host: process.env.REDIS_HOST ?? 'localhost',
            port: Number(process.env.REDIS_PORT ?? 6379),
            password: process.env.REDIS_PASSWORD,
            lazyConnect: false,
            maxRetriesPerRequest: 2,
        });
        client.on('error', () => undefined);
    }
    return client;
};

/**
 * 인증 메일의 용도. 서버의 `VerificationPurpose`와 같은 문자열이며, sink가 주소+용도로
 * 나눠 담으므로 점검이 원하는 코드를 정확히 집을 수 있다.
 */
export type MailPurpose =
    | 'signup'
    | 'reset-password'
    | 'delete'
    | 'mfa-login'
    | 'mfa-step-up'
    | 'mfa-reset-password';

export interface SinkMail {
    kind: 'signup' | 'reset-password' | 'delete' | 'mfa';
    subject: string;
    code: string;
    sentAt: string;
}

/**
 * 이 주소로 온 마지막 메일을 기다린다.
 *
 * 발송은 요청 처리 중에 일어나므로 응답이 돌아온 직후에도 아직 안 쓰였을 수 있다.
 * 짧게 여러 번 다시 본다.
 */
export async function waitForMail(
    email: string,
    purpose: MailPurpose,
    timeoutMs = 10_000,
): Promise<SinkMail> {
    const deadline = Date.now() + timeoutMs;
    let last: string | null = null;
    while (Date.now() < deadline) {
        last = await redis().get(`test:mail:${purpose}:${email}`);
        if (last !== null) return JSON.parse(last) as SinkMail;
        await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(
        `${email} 앞으로 온 ${purpose} 메일을 ${timeoutMs}ms 안에 찾지 못했습니다.`
        + ` (.env의 EMAIL_TRANSPORT가 sink인지 확인) 마지막으로 본 값: ${last ?? '없음'}`,
    );
}

/** 앞선 점검이 남긴 코드를 새 코드로 오인하지 않게, 보내기 전에 비운다. */
/**
 * 그 주소로 온 메일을 지운다. 용도를 주면 그 용도만, 안 주면 전부 지운다.
 * 흐름이 여러 용도의 코드를 쓰므로 통째로 지우면 아직 쓸 코드까지 날아간다.
 */
export async function clearMail(email: string, purpose?: MailPurpose): Promise<void> {
    const purposes: MailPurpose[] = purpose
        ? [purpose]
        : ['signup', 'reset-password', 'delete', 'mfa-login', 'mfa-step-up', 'mfa-reset-password'];
    await Promise.all(purposes.map((each) => redis().del(`test:mail:${each}:${email}`)));
}

export async function closeMail(): Promise<void> {
    if (client === null) return;
    const closing = client;
    client = null;
    await closing.quit().catch(() => undefined);
}

/**
 * 같은 주소·같은 용도의 인증 메일은 60초에 한 번만 나간다(§9의 "아주 좁게" 등급).
 * 한 흐름에서 같은 용도의 메일을 두 번 받아야 하면 그 창이 지나기를 기다려야 한다 —
 * 안 기다리면 두 번째 요청이 조용히 발송되지 않고, 화면에는 "코드를 보냈다"만 뜬다.
 *
 * 실제로 탈퇴 흐름이 여기 걸려 있었다. 23초짜리 흐름이라 60초 창 안에서 같은 주소로 다시
 * 가입하려 했고, 메일이 안 와서 제품 버그처럼 보였다.
 */
export const MAIL_REISSUE_WINDOW_MS = 60_000;

export function mailCooldownRemainingMs(previous: SinkMail, now = Date.now()): number {
    return Math.max(0, new Date(previous.sentAt).getTime() + MAIL_REISSUE_WINDOW_MS - now);
}

/** 같은 용도의 메일을 다시 받을 수 있을 때까지 기다린다. 여유를 조금 더 둔다. */
export async function waitForMailReissue(previous: SinkMail): Promise<void> {
    const remaining = mailCooldownRemainingMs(previous);
    if (remaining > 0) await new Promise((done) => setTimeout(done, remaining + 250));
}
