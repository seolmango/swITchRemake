type ReadSetting = (name: string) => string | undefined;

// Object credentials keep characters such as @, :, / and % in passwords intact.
// The same settings are used by the app and the migration command.
export function databaseConnectionOptions(read: ReadSetting) {
    const sslSetting = read('DB_SSL') ?? 'false';
    if (sslSetting !== 'true' && sslSetting !== 'false') {
        throw new Error('DB_SSL must be true or false');
    }

    const required = (name: string): string => {
        const value = read(name);
        if (!value) throw new Error(`${name} is required`);
        return value;
    };
    const port = Number(read('DB_PORT') ?? '5432');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('DB_PORT must be an integer from 1 to 65535');
    }

    return {
        host: required('DB_HOST'),
        port,
        user: required('DB_USER'),
        password: required('DB_PASSWORD'),
        database: required('DB_NAME'),
        ssl: sslSetting === 'true' ? { rejectUnauthorized: true } : false,
    };
}
