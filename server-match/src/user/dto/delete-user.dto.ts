import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class DeleteUserDto {
    @IsString()
    @Length(6, 6, { message: 'Verification code is 6 digits' })
    code!: string;

    /** TOTP 방식 계정만 필요하다. 메일 방식은 위 탈퇴 메일 코드가 선택한 2차 수단이기도 하다. */
    @IsOptional()
    @IsString()
    @Matches(/^(?:\d{6}|[0-9A-Fa-f]{8}(?:-[A-Za-z2-7]{4}){4})$/)
    secondFactorCode?: string;
}
