import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { IsValidPassword } from '../../user/dto/password.validator';

export class ResetPasswordDto {
    @IsEmail()
    email!: string;

    @IsString()
    @Length(6, 6)
    @Matches(/^[0-9]{6}$/)
    code!: string;

    @IsValidPassword()
    newPassword!: string;
}
