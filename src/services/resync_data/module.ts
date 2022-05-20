import { Module } from "@nestjs/common";
import { ResyncDataService } from "./service";
import { DatabaseCounterModule } from "../db_count_checker/module";
@Module({
  imports: [DatabaseCounterModule],
  providers: [ResyncDataService],
  exports: [ResyncDataService],
})
export class ResyncDataModule {}
