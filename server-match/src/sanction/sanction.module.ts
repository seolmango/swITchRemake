import { Module } from '@nestjs/common';
import { SanctionService } from './sanction.service';
import { SessionModule } from '../session/session.module';

@Module({
    imports: [SessionModule],
    providers: [SanctionService],
    exports: [SanctionService],
})
export class SanctionModule {}
