require("dotenv").config();
import {
  Injectable,
  Logger,
  HttpService,
  BadGatewayException,
} from "@nestjs/common";

import Bluebird from "bluebird";
import { flattenDeep, times } from "lodash";
import { DatabaseCounterService } from "../db_count_checker/service";
import { AddTimeline } from "@dnamicro/service-common/build/request";
import { GqlProperties } from "@dnamicro/schema-common";

const {
  DATABASE = "gorentals_core",
  SCHEMA_VERSION = "v4",
  RESYNC_STORE_ENDPOINT = "http://localhost:8080",
  RESYNC_STORE_AUTH_USERNAME = "admin",
  RESYNC_STORE_AUTH_PASSWORD = "admin",
  BACKUP_STORAGE_REDIS_HOST,
} = process.env;

const logger = new Logger("RESYNC-DATA:SERVICE", true);

logger.log("INITIATED");

// TODO: support other protocols
@Injectable()
export class ResyncDataService {
  private httpService: HttpService;
  private store_endpoint: string;
  operation: string = "insert";
  old_data: any = { _: "" };
  constructor(private DatabaseCounterService: DatabaseCounterService) {
    this.httpService = new HttpService();
    this.store_endpoint = RESYNC_STORE_ENDPOINT;
  }
  async getRecordsById(entity: string, record_ids: Array<string>) {
    const records = Bluebird.map(record_ids, async (record_id: string) => {
      const result = await this.httpService
        .get(
          `${this.store_endpoint}/${DATABASE}_db_${SCHEMA_VERSION}/${entity}/${record_id}`,
          {
            auth: {
              username: RESYNC_STORE_AUTH_USERNAME,
              password: RESYNC_STORE_AUTH_PASSWORD,
            },
          }
        )
        .toPromise()
        .then((response: any) => {
          return response.data;
        })
        .catch((err: any) => {
          logger.error(`Re-Sync Error: ${err}`);
          throw new BadGatewayException(err.message ? err.message : err);
        });
      logger.log(
        `EXECUTING GetRecordsById: ID:${record_id}, host(Back-up reliable store, ${BACKUP_STORAGE_REDIS_HOST}), ${new Date().toISOString()}, user: ${RESYNC_STORE_AUTH_USERNAME}, entity: ${entity}, results: ${
          Object.keys(result).length
            ? "Successfully retrieved record"
            : "Record does not exist"
        } )`
      );
      return result;
    });
    return records;
  }
  async insertRecords(
    entity: string,
    records: Array<Record<string, any>>,
    gql_properties?: GqlProperties
  ) {
    const data = Bluebird.map(
      records,
      async (record_data: Record<string, any>) => {
        const result = await this.httpService
          .post(
            `${this.store_endpoint}/insert/${DATABASE}_db_${SCHEMA_VERSION}/${entity}`,
            record_data,
            {
              auth: {
                username: RESYNC_STORE_AUTH_USERNAME,
                password: RESYNC_STORE_AUTH_PASSWORD,
              },
            }
          )
          .toPromise()
          .then((response: any) => response.data)
          .catch((err: any) => {
            logger.error(`Re-Sync Error: ${err}`);
            throw new BadGatewayException(err.message ? err.message : err);
          });
        const {
          application_id = "",
          company_id = "",
          user_id = "",
          user_role_id = "",
          user_agent = {},
        } = gql_properties || {};

        const metadata = {
          application_id,
          company_id,
          user_agent,
          [`${
            this.operation.slice(-1) == "e"
              ? this.operation
              : this.operation + "e"
          }d_by`]: {
            user_id,
            user_role_id,
          },
        };
        AddTimeline(
          !!Object.keys(result).length,
          result,
          // ${entity_name}$v{number}
          entity,
          DATABASE.split("_core")[0],
          this.operation,
          metadata,
          gql_properties as GqlProperties,
          this.old_data
        );
        logger.log(
          `EXECUTING InsertRecords: ID:${record_data.id}, host(ReSync Store, ${
            this.store_endpoint
          }), ${new Date().toISOString()}, user: ${RESYNC_STORE_AUTH_USERNAME}, entity: ${entity}, results: ${
            Object.keys(result).length
              ? "Successfully inserted record"
              : "Something went wrong during insertion."
          } )`
        );
        return result;
      }
    );
    return data;
  }
  resync = async () => {
    const get_all_counts_data = await this.DatabaseCounterService.getAllCounts();
    const { out_of_sync_records, max_count, min_count } = get_all_counts_data;
    if (max_count === min_count)
      return {
        success: false,
        message: "There is no need to re-Sync. All databases synchronized.",
      };
    logger.warn(
      `[Re-Sync]: Out-Of-Sync-IDs: ${JSON.stringify(out_of_sync_records)}`
    );
    return await Bluebird.map(
      Object.entries(out_of_sync_records),
      async ([entity, record_ids]) => {
        const total_count_of_records_per_entity = record_ids.length;
        let progress_bar: string[] = [...new Array(10)].map((_e) => "*");
        let percentage = `0%`;
        const limit = 2;
        let batches = Math.round(total_count_of_records_per_entity / limit);
        if (batches * limit < total_count_of_records_per_entity) batches += 1;
        let new_limit = limit;
        const percentage_bar: any = [];
        let total_resynced_data: number = 0;

        const batching_results: Array<any> = await Bluebird.mapSeries(
          times(batches),
          async (batch) => {
            const current_batch = batch + 1;
            if (current_batch === batches)
              new_limit =
                total_resynced_data +
                (total_count_of_records_per_entity - total_resynced_data);
            const curr_batch_record_ids = record_ids.slice(
              total_resynced_data,
              new_limit
            );
            const records_data: Array<
              Record<string, any>
            > = await this.getRecordsById(entity, curr_batch_record_ids);
            const insert_response: Array<
              Record<string, any>
            > = await this.insertRecords(entity, records_data);

            const calc = (current_batch / batches) * 100;
            percentage = calc.toFixed(2) + "%";
            const rounded = Math.floor(calc);
            if (!percentage_bar.includes(rounded)) {
              percentage_bar.push(rounded);
            }
            const calculated_index = Math.round(rounded / 10);
            progress_bar[calculated_index] = `|`;

            logger.log(
              `[Progress]: ${total_resynced_data}/${total_count_of_records_per_entity}`
            );
            logger.warn(`[${progress_bar.join("")}]  ${percentage}`);
            logger.warn(`[Batches]: ${current_batch}/${batches}`);
            logger.warn(
              `ReSyncing in progress: host(ReSync Store , ${
                this.store_endpoint
              }), ${new Date().toISOString()}, user: ${RESYNC_STORE_AUTH_USERNAME}, entity: ${entity}, results: ${
                insert_response.map(({ id }) => id).length ===
                curr_batch_record_ids.length
                  ? "Successfully reSynced current batched records"
                  : "Failed to resync current batched records."
              }`
            );
            total_resynced_data = current_batch * limit;
            new_limit = total_resynced_data + limit;
            return insert_response.map(({ id }) => id);
          }
        );
        logger.log(
          `ReSyncing done: host(ReSync Store , ${
            this.store_endpoint
          }), ${new Date().toISOString()}, user: ${RESYNC_STORE_AUTH_USERNAME}, entity: ${entity}, results: ${
            flattenDeep(batching_results).length ===
            total_count_of_records_per_entity
              ? "Successfully reSynced records of current entity."
              : "Failed to resync records of current entity."
          }`
        );
        return flattenDeep(batching_results);
      }
    )
      .then((inserted_ids) => {
        if (
          Object.values(out_of_sync_records).flat().length ===
          inserted_ids.flat().length
        ) {
          return {
            success: true,
            message: "Successfully re-Synced data.",
            inserted_records: out_of_sync_records,
          };
        } else {
          return {
            success: false,
            message: "Failed to re-Synced data.",
          };
        }
      })
      .catch((err) => {
        this.DatabaseCounterService.sendNotifToGlip(
          `Re-Sync Store host: ${this.store_endpoint} Offline/Unavailable.`,
          "Re-Sync Service Notification",
          err.response ? err.response : err
        );
        throw new BadGatewayException(err.response ? err.response : err);
      });
  };
}
