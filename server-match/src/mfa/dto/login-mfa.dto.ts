import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

export class LoginMfaDto {
    @IsString()
    @Length(64, 256)
    challengeToken!: string;

    @IsString()
    @Matches(/^(?:\d{6}|[0-9A-Fa-f]{8}(?:-[A-Za-z2-7]{4}){4})$/)
    code!: string;

    @IsOptional()
    @IsBoolean()
    trustDevice?: boolean;
}

export class LoginMfaEmailDto {
    @IsString()
    @Length(64, 256)
    challengeToken!: string;
}
