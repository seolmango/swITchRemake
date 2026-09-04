import { IsString, MaxLength, MinLength } from 'class-validator';

export class GuestRefreshDto {
    @IsString()
    @MinLength(1)
    @MaxLength(4096)
    refreshToken!: string;
}
