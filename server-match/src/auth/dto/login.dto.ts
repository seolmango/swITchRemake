import { IsEmail, IsString, Length, Matches } from "class-validator";
import { Transform } from 'class-transformer';

export class LoginDto {
    @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
    @IsEmail()
    email!: string;

    @IsString()
    @Length(8, 20)
    @Matches(/^[A-Za-z0-9!@#$%^&*]+$/)
    password!: string;
}
