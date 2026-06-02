import { IsEmail, IsString, Length, Matches } from "class-validator";

export class LoginDto {
    @IsEmail()
    email!: string;

    @IsString()
    @Length(8, 20)
    @Matches(/^[A-Za-z0-9!@#$%^&*]+$/)
    password!: string;
}