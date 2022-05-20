import { Module } from "@nestjs/common";
import { DatabaseCounterService } from "./service";

@Module({
  imports: [],
  providers: [DatabaseCounterService],
  exports: [DatabaseCounterService],
})
export class DatabaseCounterModule {}
