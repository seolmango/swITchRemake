import { Equals, IsEmail, IsString, Length, Matches } from "class-validator";
import { Transform } from 'class-transformer';
import { IsValidPassword } from './password.validator';
import { LegalConsentDto } from './legal-consent.dto';

export class CreateUserDto extends LegalConsentDto {
    @Equals(true, { message: 'You must be at least 14 years old' })
    isOver14!: boolean;

    @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
    @IsEmail()
    email!: string;

    @IsValidPassword()
    password!: string;

    @IsString()
    @Length(2, 12)
    @Matches(/^[A-Za-z0-9가-힣]+$/)
    nickname!: string;

    @IsString()
    @Length(6, 6, { message: 'Verification code is 6 digits' })
    code!: string;
}
