import { Injectable, Inject, ConflictException, InternalServerErrorException, BadRequestException, NotFoundException, UnauthorizedException} from "@nestjs/common";
import { DRIZZLE } from "../database/database.module";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from '../database/schema';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from "./dto/create-user.dto";
import { RedisService } from "../redis/redis.service";
import { eq } from 'drizzle-orm';
import { SanctionService } from '../sanction/sanction.service';
import { SessionService } from '../session/session.service';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UserService {
    constructor(
        @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
        private readonly redisService: RedisService,
        private readonly sanctionService: SanctionService,
        // Password changes must revoke every other authenticated session, so
        // this application service intentionally owns the SessionService dependency.
        private readonly sessionService: SessionService,
    ) {}

    async createUser(dto: CreateUserDto) {
        const { email, password, nickname, code } = dto;
        const redisKey = `auth:code:signup:${email}`;

        const savedCode = await this.redisService.get(redisKey);
        if (!savedCode) {
            throw new BadRequestException('Verification code expired or not found');
        }
        if (savedCode !== code) {
            throw new BadRequestException('Invalid verification code');
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        try {
            const [newUser] = await this.db.insert(schema.users).values({
                email,
                passwordHash,
                nickname,
            }).returning({
                nickname: schema.users.nickname,
            });

            await this.redisService.del(redisKey);

            return newUser;
        } catch (error: any) {
            if (error.code === '23505') {
                if (error.details.includes('email')) {
                    throw new ConflictException('Email already exists');
                }
                if (error.details.includes('nickname')) {
                    throw new ConflictException('Nickname already exists');
                }
            }
            throw new InternalServerErrorException('Failed to create user');
        }
    }

    async deleteUser(
        userId: number,
        code: string,
        requestMeta: Record<string, unknown>,
    ): Promise<void> {
        const [user] = await this.db.select({ email: schema.users.email })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const redisKey = `auth:code:delete:${user.email}`;
        const savedCode = await this.redisService.get(redisKey);
        if (!savedCode || savedCode !== code) {
            throw new BadRequestException('Invalid or expired verification code');
        }

        await this.sanctionService.deleteAccount(
            userId,
            `user:${userId}`,
            'User requested account deletion',
            requestMeta,
        );
        await this.redisService.del(redisKey);
    }

    async changePassword(userId: number, currentSessionId: string, dto: ChangePasswordDto) {
        await this.sessionService.assertOwnedActiveSession(userId, currentSessionId);
        const [user] = await this.db.select({ passwordHash: schema.users.passwordHash })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
        if (!user) throw new NotFoundException('User not found');

        if (!await bcrypt.compare(dto.currentPassword, user.passwordHash)) {
            throw new UnauthorizedException('Current password is incorrect');
        }
        if (await bcrypt.compare(dto.newPassword, user.passwordHash)) {
            throw new BadRequestException('New password must differ from the current password');
        }

        const passwordHash = await bcrypt.hash(dto.newPassword, 10);
        await this.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
        const revokedCount = await this.sessionService.revokeOthers(userId, currentSessionId);
        return { revokedCount };
    }
}
