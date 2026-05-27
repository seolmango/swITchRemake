import {Injectable, InternalServerErrorException, Inject, UnauthorizedException} from "@nestjs/common";
import {RedisService} from "../redis/redis.service";
import {EmailService} from "../email/email.service";
import {EmailAuthType, SendEmailDto} from "./dto/email-auth.dto";
import {JwtService} from "@nestjs/jwt";
import {ConfigService} from "@nestjs/config";
import {DRIZZLE} from "../database/database.module";
import {PostgresJsDatabase} from "drizzle-orm/postgres-js";
import * as schema from '../database/schema';
import {eq} from 'drizzle-orm';
import * as bcrypt from 'bcrypt';
import {LoginDto, RefreshTokenDto } from "./dto/login.dto";


@Injectable()
export class AuthService {
    constructor(
        @Inject(DRIZZLE) private db: PostgresJsDatabase,
        private readonly redisService: RedisService,
        private readonly emailService: EmailService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) {}

    async sendVerificationCodeEmail(dto: SendEmailDto) {
        const { email, vtype } = dto;

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const redisKey = `auth:code:${vtype}:${email}`;
        await this.redisService.set(redisKey, code, 300);

        let emailSent = false;
        switch (vtype) {
            case EmailAuthType.SIGNUP:
                emailSent = await this.emailService.sendRegistrationCodeEmail(email, code);
                break;
            case EmailAuthType.RESET_PASSWORD:
                emailSent = await this.emailService.sendPasswordResetCodeEmail(email, code);
                break;
            case EmailAuthType.DELETE:
                emailSent = await this.emailService.sendDeleteAccountCodeEmail(email, code);
                break;
        }
        if (!emailSent) {
            throw new InternalServerErrorException('Verification email send failed');
        }

        return {
            message: 'Verification code sent successfully',
        }
    }

    async login(dto: LoginDto) {
        const { email, password } = dto;
        const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email));

        if (!user) {
            throw new UnauthorizedException('Invalid email or password');
        }

        const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid email or password');
        }

        return this.generateToken(user.id, user.email);
    }

    async refresh(dto: RefreshTokenDto) {
        const { refreshToken } = dto;

        try {
            const payload = this.jwtService.verify(refreshToken, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
            });

            const redisKey = `auth:refresh:${payload.sub}`;
            const savedToken = await this.redisService.get(redisKey);

            if (!savedToken || savedToken !== refreshToken) {
                throw new UnauthorizedException('Invalid refresh token');
            }

            await this.redisService.del(redisKey);

            const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, payload.sub));
            if (!user) {
                throw new UnauthorizedException('Invalid user');
            }
            return this.generateToken(user.id, user.email);
        } catch {
            throw new UnauthorizedException('Invalid refresh token');
        }
    }

    private async generateToken(userId: number, email: string) {
        const payload = {
            sub: userId, email
        };

        const accessToken = this.jwtService.sign(payload, {
            secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
            expiresIn: Number(this.configService.get<number>('JWT_ACCESS_EXPIRATION')),
        });

        const refreshToken = this.jwtService.sign(payload, {
            secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
            expiresIn: Number(this.configService.get<number>('JWT_REFRESH_EXPIRATION')),
        });

        const redisKey = `auth:refresh:${userId}`;
        const ttl = this.configService.get<number>('JWT_REFRESH_EXPIRATION');
        await this.redisService.set(redisKey, refreshToken, ttl);

        return { accessToken, refreshToken };
    }
}