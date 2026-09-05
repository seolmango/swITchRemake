import { IsString, Matches } from 'class-validator';

/** TOTP/메일 6자리 또는 서버가 발급한 백업 코드 한 개. */
export class MfaCodeDto {
    @IsString()
    @Matches(/^(?:\d{6}|[0-9A-Fa-f]{8}(?:-[A-Za-z2-7]{4}){4})$/)
    code!: string;
}
