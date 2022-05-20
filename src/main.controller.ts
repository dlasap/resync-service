import { Controller, Get, Logger, Response, Post } from "@nestjs/common";
import { Response as ExpressResponse } from "express";
import { MainService } from "./main.service";
import { PromMonit } from "@dnamicro/service-common/build/utils/decorators";

const logger = new Logger("MAIN:CONTROLLER");
const client = require("prom-client");
client.collectDefaultMetrics({ timeout: 5000 });
global.prom_client = client;

@Controller()
export class MainController {
  prom_client: any;
  constructor(private mainService: MainService) {}

  @Get("/metrics")
  async monitor(@Response() res: any) {
    res.set("Content-Type", global.prom_client.register.contentType);
    const result = await global.prom_client.register.metrics();
    res.end(result);
  }

  // ignore default icon request
  @Get("/favicon.ico")
  async icon(@Response() res: ExpressResponse) {
    res.writeHead(200, { "Content-Type": "image/x-icon" });
    res.end();
    logger.log("favicon requested");
  }

  @Get("/allcounts")
  @PromMonit({ client: global.prom_client })
  async getAllCounts() {
    return this.mainService.getAllCounts();
  }

  @Post("/resync")
  @PromMonit({ client: global.prom_client })
  async getResync() {
    return this.mainService.getAllResyncData();
  }
}
