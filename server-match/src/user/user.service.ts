import { Injectable, Inject, ConflictException, InternalServerErrorException, BadRequestException, NotFoundException} from "@nestjs/common";
import { DRIZZLE } from "../database/database.module";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from '../database/schema';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from "./dto/create-user.dto";
import { RedisService } from "../redis/redis.service";
import { eq } from 'drizzle-orm';
import { SanctionService } from '../sanction/sanction.service';

@Injectable()
export class UserService {
    constructor(
        @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
        private readonly redisService: RedisService,
        private readonly sanctionService: SanctionService,
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
}
