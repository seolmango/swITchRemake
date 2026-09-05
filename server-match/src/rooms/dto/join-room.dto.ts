import { IsOptional, IsString, Matches } from 'class-validator';

export class JoinRoomDto {
    @IsOptional()
    @IsString()
    @Matches(/^\d{4,8}$/, { message: 'password must be 4 to 8 digits' })
    password?: string;
}
