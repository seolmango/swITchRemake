import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsValidPassword } from '../../user/dto/password.validator';

export class ResetPasswordDto {
    @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
    @IsEmail()
    email!: string;

    @IsString()
    @Length(6, 6)
    @Matches(/^[0-9]{6}$/)
    code!: string;

    @IsValidPassword()
    newPassword!: string;

    /** 2차 인증이 꺼져 있으면 생략한다. 메일 방식은 별도 재설정용 코드, TOTP 방식은 TOTP/백업 코드다. */
    @IsOptional()
    @IsString()
    @Matches(/^(?:\d{6}|[0-9A-Fa-f]{8}(?:-[A-Za-z2-7]{4}){4})$/)
    secondFactorCode?: string;
}
