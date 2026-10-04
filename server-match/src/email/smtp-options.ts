import type SMTPPool from 'nodemailer/lib/smtp-pool';

type ReadSetting = (name: string) => string | undefined;

export function smtpOptions(read: ReadSetting): SMTPPool.Options {
    const port = Number(read('SMTP_PORT') ?? '465');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid port');
    const secure = read('SMTP_SECURE') ?? 'true';
    if (secure !== 'true' && secure !== 'false') throw new Error('SMTP_SECURE must be true or false');
    const user = read('SMTP_USER');
    const password = read('SMTP_PASSWORD');
    if (Boolean(user) !== Boolean(password)) throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
    return {
        host: read('SMTP_HOST') || 'smtp.gmail.com', port, secure: secure === 'true',
        pool: true, maxConnections: 5,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
        ...(user && password ? { auth: { user, pass: password } } : {}),
    };
}
