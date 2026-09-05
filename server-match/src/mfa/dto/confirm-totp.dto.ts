import { IsString, Length, Matches } from 'class-validator';

export class ConfirmTotpDto {
    @IsString()
    @Length(32, 128)
    setupToken!: string;

    @IsString()
    @Matches(/^\d{6}$/)
    code!: string;
}
