import { IsEmail, IsEnum, IsString, Length } from 'class-validator';

export enum EmailAuthType {
    SIGNUP = 'signup',
    RESET_PASSWORD = 'reset-password',
    DELETE = 'delete',
}

export class SendEmailDto {
    @IsEmail()
    email!: string;

    @IsEnum(EmailAuthType, { message: 'vtype은 signup, reset-password, delete 중 하나여야 합니다.' })
    vtype!: EmailAuthType;
}