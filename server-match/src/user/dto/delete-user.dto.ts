import { IsString, Length } from 'class-validator';

export class DeleteUserDto {
    @IsString()
    @Length(6, 6, { message: 'Verification code is 6 digits' })
    code!: string;
}
