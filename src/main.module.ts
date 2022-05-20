import { Module } from "@nestjs/common";
import { MainController } from "./main.controller";
import { MainService } from "./main.service";
import { DatabaseCounterModule } from "./services/db_count_checker/module";
import { ResyncDataModule } from "./services/resync_data/module";

@Module({
  imports: [DatabaseCounterModule, ResyncDataModule],
  controllers: [MainController],
  providers: [MainService],
})
export class MainModule {}
