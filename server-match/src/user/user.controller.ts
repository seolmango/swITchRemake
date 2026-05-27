import { Controller, Post, Body } from "@nestjs/common";
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { RateLimiter } from "../ratelimiter.decorator";

@Controller('users')
export class UserController {
    constructor(
        private readonly userService: UserService,
    ) {}

    @Post('register')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async register(@Body() createUserDto: CreateUserDto) {
        return this.userService.createUser(createUserDto);
    }
}