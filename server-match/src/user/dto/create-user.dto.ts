import { IsEmail, IsString, Length, Matches } from "class-validator";

export class CreateUserDto {
    @IsEmail()
    email!: string;

    @IsString()
    @Length(8, 20)
    @Matches(/^[A-Za-z0-9!@#$%^&*]+$/)
    password!: string;

    @IsString()
    @Length(2, 12)
    @Matches(/^[A-Za-z0-9가-힣]+$/)
    nickname!: string;

    @IsString()
    @Length(6, 6, { message: 'Verification code is 6 digits' })
    code!: string;
}