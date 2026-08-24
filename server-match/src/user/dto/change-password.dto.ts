import { IsValidPassword } from './password.validator';

export class ChangePasswordDto {
    @IsValidPassword()
    currentPassword!: string;

    @IsValidPassword()
    newPassword!: string;
}
