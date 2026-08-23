import { Module } from '@nestjs/common';
import { SanctionService } from './sanction.service';

@Module({
    providers: [SanctionService],
    exports: [SanctionService],
})
export class SanctionModule {}
