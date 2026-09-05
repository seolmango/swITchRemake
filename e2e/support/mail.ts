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
    expectKind: SinkMail['kind'],
    timeoutMs = 10_000,
): Promise<SinkMail> {
    const deadline = Date.now() + timeoutMs;
    let last: string | null = null;
    while (Date.now() < deadline) {
        last = await redis().get(`test:mail:${email}`);
        if (last !== null) {
            const mail = JSON.parse(last) as SinkMail;
            if (mail.kind === expectKind) return mail;
        }
        await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(
        `${email} 앞으로 온 ${expectKind} 메일을 ${timeoutMs}ms 안에 찾지 못했습니다.`
        + ` (.env의 EMAIL_TRANSPORT가 sink인지 확인) 마지막으로 본 값: ${last ?? '없음'}`,
    );
}

/** 앞선 점검이 남긴 코드를 새 코드로 오인하지 않게, 보내기 전에 비운다. */
export async function clearMail(email: string): Promise<void> {
    await redis().del(`test:mail:${email}`);
}

export async function closeMail(): Promise<void> {
    if (client === null) return;
    const closing = client;
    client = null;
    await closing.quit().catch(() => undefined);
}
