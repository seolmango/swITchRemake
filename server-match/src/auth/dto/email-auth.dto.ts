import { IsEmail, IsEnum, IsString, Length } from 'class-validator';

export enum EmailAuthType {
    SIGNUP = 'signup',
    RESET_PASSWORD = 'reset-password',
    DELETE = 'delete',
}

export class SendEmailDto {
    @IsEmail()
    email!: string;

    @IsEnum(EmailAuthType, { message: 'vtype must be signup or reset-password or delete' })
    vtype!: EmailAuthType;
}