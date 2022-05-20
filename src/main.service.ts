import { Injectable } from "@nestjs/common";
import { DatabaseCounterService } from "./services/db_count_checker/service";
import { ResyncDataService } from "./services/resync_data/service";

@Injectable()
export class MainService {
  constructor(
    private DatabaseCounterService: DatabaseCounterService,
    private ResyncDataService: ResyncDataService
  ) {}
  async getAllCounts() {
    return await this.DatabaseCounterService.getAllCounts();
  }
  async getAllResyncData() {
    return await this.ResyncDataService.resync();
  }
}
