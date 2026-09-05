import { IsValidPassword } from '../../user/dto/password.validator';

export class EnableMfaDto {
    @IsValidPassword()
    currentPassword!: string;
}
