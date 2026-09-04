import { IsEmail, IsEnum, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export enum EmailAuthType {
    SIGNUP = 'signup',
    RESET_PASSWORD = 'reset-password',
    DELETE = 'delete',
}

export class SendEmailDto {
    @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
    @IsEmail()
    email!: string;

    @IsEnum(EmailAuthType, { message: 'vtype must be signup or reset-password or delete' })
    vtype!: EmailAuthType;
}
