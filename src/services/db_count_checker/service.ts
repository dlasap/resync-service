require("dotenv").config();
const rp = require("request-promise");
import { Injectable, Logger, BadGatewayException } from "@nestjs/common";
import { createClient } from "redis";
import { Client } from "elasticsearch";
import rethinkdbdash, { ConnectOptions } from "rethinkdbdash";
import { map, mapSeries, each } from "bluebird";
import { flatMapDeep, times } from "lodash";
import { AnyObject } from "@dnamicro/schema-common";

const {
  ELASTIC_HOSTS = "https://localhost:9200",
  ELASTIC_USERNAME = "admin",
  ELASTIC_PASSWORD = "admin",
  REDIS_HOSTS = "localhost:6371,localhost:6372",
  DATABASE = "gorentals",
  SCHEMA_VERSION = "v4",
  BACKUP_STORAGE_REDIS_HOST = "localhost:6371",
  RETHINK_HOSTS = "https://10.100.100.131:8085,https://10.100.100.131:8085",
  BATCH_LIMIT = "1000",
  EXCLUDED_ENTITIES = "wizard_data",
  ERROR_LOG_WEB_HOOK_URL = "https://hooks.glip.com/webhook/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvdCI6InUiLCJvaSI6IjM5NjU4MjMzODU2MyIsImlkIjoiMTMyOTQxNDE3MSJ9.-Re5RF-tvrwQqSicLHBYbY0M7mChoZNw4wXv4irweOs",
} = process.env;
const logger = new Logger("GET-DB-COUNTS-SERVICE", true);

const redis_hosts = REDIS_HOSTS.trim()?.split(",");
const elastic_hosts = ELASTIC_HOSTS.trim()?.split(",");
const rethink_hosts = RETHINK_HOSTS.trim()?.split(",");
const excluded_entities = EXCLUDED_ENTITIES.trim().split(",");
const RETHINK_DB = `${DATABASE}_db_${SCHEMA_VERSION}`;

logger.log("INITIATED");

@Injectable()
export class DatabaseCounterService {
  private redis_hosts: Array<string>;
  private elastic_hosts: Array<string>;
  private rethink_hosts: Array<string>;
  private backup_storage_redis_host: string;
  private batch_limit: number;
  constructor() {
    this.redis_hosts = redis_hosts;
    this.elastic_hosts = elastic_hosts;
    this.rethink_hosts = rethink_hosts;
    this.backup_storage_redis_host = BACKUP_STORAGE_REDIS_HOST;
    this.batch_limit = Number(BATCH_LIMIT);
  }
  async createRedisClient(url: string) {
    try {
      const [url_host, url_port] = url.split(":");

      const client = createClient({
        socket: {
          host: url_host,
          port: parseInt(url_port),
        },
      });
      await client.connect();
      client.on("error", (err) => {
        console.log("Redis Client Error", err);
        client.disconnect();
      });
      logger.log(
        `Creating Redis Client :  host(REDIS , ${url}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: Successfully made Redis Client.`
      );

      return client;
    } catch (error: any) {
      this.sendNotifToGlip(
        `Redis host: ${url} Offline/Unavailable.`,
        "Re-Sync Service Notification",
        error.message ? error.message : error
      );
      throw new BadGatewayException(error.message ? error.message : error);
    }
  }
  async createElasticClient(url: string) {
    const client = new Client({
      host: url,
      httpAuth: `${ELASTIC_USERNAME}:${ELASTIC_PASSWORD}`,
    });
    logger.log(
      `Creating Elastic Client :  host(ELASTIC , ${url}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: Successfully made Elastic Client.`
    );
    return client;
  }

  async createRethinkClient(url: string) {
    const [host, port] = url.split(":");
    const client = rethinkdbdash({
      host: host.toString(),
      port: Number(port),
    } as ConnectOptions);
    logger.log(
      `Creating Rethink Client :  host(RETHINK , ${url}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: Successfully made Rethink Client.`
    );
    return client;
  }

  async getRedisDBCounts(redis_hosts: Array<string>) {
    const result = map(
      redis_hosts,
      async (host: string) => {
        const client = await this.createRedisClient(host.trim());
        const cmd_res: string = await client
          .sendCommand(["info", "keyspace"])
          .then((result: any) => result)
          .catch((error) => {
            this.sendNotifToGlip(
              `Redis host: ${host} Offline/Unavailable.`,
              "Re-Sync Service Notification",
              error
            );
            throw new BadGatewayException(error);
          });
        if (!cmd_res.split("keys=")[1])
          return { message: "No available data." };

        const cmd_keys: Array<string> = await client.sendCommand(["keys", "*"]);
        const entity_index = `${DATABASE}_db_${SCHEMA_VERSION}:`;

        let entity_counts: Record<string, any> = {};
        let total_data_count = 0;

        const entities = cmd_keys
          .map((item: any) => {
            if (item.includes(`database:${entity_index}`)) {
              const entity = item.split(":")[2];
              if (excluded_entities.includes(entity)) return;
              entity_counts = {
                ...entity_counts,
                [entity]: 0,
              };
              return entity;
            }
          })
          .filter(Boolean);

        cmd_keys.forEach((k: string) => {
          const entity = k.split(":")[1];
          if (
            k.includes(entity_index) &&
            entities.includes(entity) &&
            k.includes("item")
          ) {
            total_data_count += 1;
            entity_counts = {
              ...entity_counts,
              [entity]: entity_counts[entity] + 1,
            };
          }
        });
        client.disconnect();
        logger.log(
          `Getting REDIS DB COUNT :  host(REDIS , ${host}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: {TOTAL COUNT:${total_data_count}, ${JSON.stringify(
            entity_counts,
            null,
            2
          )}}`
        );

        return {
          host,
          total_data_count,
          entity_counts,
        };
      },
      { concurrency: 10 }
    );
    return result;
  }
  async getElasticDBCounts(elastic_hosts: Array<string>) {
    const db_index = `${DATABASE}_db_${SCHEMA_VERSION}`;

    const result = map(
      elastic_hosts,
      async (host: string) => {
        const client = await this.createElasticClient(host.trim());
        const entities = await client.indices
          .get({
            index: `${db_index}-*`,
          })
          .then((response: any) => {
            return Object.keys(response).map((str: string) =>
              str.replace(`${db_index}-`, "").replace(`_v1`, "")
            );
          })
          .catch((error) => {
            this.sendNotifToGlip(
              `Elastic host: ${host} Offline/Unavailable.`,
              "Re-Sync Service Notification",
              error
            );
            throw new BadGatewayException(error);
          });
        let entity_counts: Record<string, any> = {};
        let total_data_count = 0;
        await each(entities, async (entity: string) => {
          const { count } = await client.count({
            index: `${db_index}-${entity}_v1`,
          });
          total_data_count += count;
          entity_counts = {
            ...entity_counts,
            [entity]: count,
          };
        });
        logger.log(
          `Getting ELASTIC DB COUNT :  host(ELASTIC , ${host}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: {TOTAL COUNT:${total_data_count}, ${JSON.stringify(
            entity_counts,
            null,
            2
          )}}`
        );

        return {
          host,
          total_data_count,
          entity_counts,
        };
      },
      { concurrency: 10 }
    );

    return result;
  }

  async getRethinkDBCounts(rethink_hosts: Array<string>) {
    return await map(rethink_hosts, async (host: string) => {
      const rethink = await this.createRethinkClient(host.trim());
      const entities = await rethink
        .db(RETHINK_DB)
        .tableList()
        .run()
        .then((res) => res)
        .catch((error) => {
          this.sendNotifToGlip(
            `RethinkDB host: ${host} Offline/Unavailable.`,
            "Re-Sync Service Notification",
            error
          );
          throw new BadGatewayException(error);
        });
      let total_data_count = -0;
      let entity_counts: Record<string, any> = {};
      await each(entities, async (entity: string) => {
        if (excluded_entities.includes(entity)) return;
        const count = await rethink.db(RETHINK_DB).table(entity).count().run();
        total_data_count += count;
        entity_counts = {
          ...entity_counts,
          [entity]: count,
        };
      });
      logger.log(
        `Getting RETHINK DB COUNT :  host(RETHINK , ${host}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: {TOTAL COUNT:${total_data_count}, ${JSON.stringify(
          entity_counts,
          null,
          2
        )}}`
      );
      return {
        host,
        total_data_count,
        entity_counts,
      };
    });
  }

  async getOutOfSyncIdsPerHost(
    db_name: string,
    db_count: Record<string, any>[],
    backup_storage_entity_counts: Record<string, any>,
    min_count: number,
    curr_out_of_sync_hosts: Record<string, any>[],
    curr_out_of_sync_records: Record<string, any>,
    { getBackupData, getDataInCurrDB, getOutOfSyncIds }: any
  ) {
    let curr_min_count: number = min_count;
    let out_of_sync_hosts = curr_out_of_sync_hosts;
    let out_of_sync_records = curr_out_of_sync_records;
    const entities = Object.keys(backup_storage_entity_counts);
    await each(db_count, async (item: any) => {
      const { total_data_count, host, entity_counts = {} } = item;
      if (total_data_count < min_count || total_data_count === min_count) {
        curr_min_count = total_data_count;
      }
      let lookup_entities: Record<string, any> = {};
      let back_up_lookup_entities: Record<string, any> = {};

      entities.forEach((entity: string) => {
        if (backup_storage_entity_counts[entity] !== entity_counts[entity]) {
          if (!lookup_entities[entity]) {
            lookup_entities = {
              ...lookup_entities,
              [entity]: entity_counts[entity],
            };
            back_up_lookup_entities = {
              ...back_up_lookup_entities,
              [entity]: backup_storage_entity_counts[entity],
            };
          }
        }
      });
      if (Object.keys(lookup_entities).length) {
        out_of_sync_hosts.push({
          db_name,
          host,
          total_data_count,
          out_of_sync_entities: Object.keys(lookup_entities),
          entity_counts,
        });

        const reliable_data = await getBackupData(
          this.backup_storage_redis_host,
          Object.entries(back_up_lookup_entities)
        );
        const rethink_data_ids = await getDataInCurrDB(
          host,
          Object.entries(lookup_entities)
        );
        out_of_sync_records = await getOutOfSyncIds(
          reliable_data,
          rethink_data_ids,
          out_of_sync_records
        );
      }
    });
    return { curr_min_count, out_of_sync_records };
  }
  async getDataRedis(host: string, entities: Array<Array<any>>) {
    const result = map(entities, async ([entity, _entity_count]) => {
      const client = await this.createRedisClient(host);
      const entity_index: string = `${DATABASE}_db_${SCHEMA_VERSION}:${entity}:item:`;
      const cmd_res: Array<string> = await client.sendCommand(["keys", "*"]);

      const record_ids = cmd_res
        .map((k: string) => {
          if (k.includes(entity_index)) return k.replace(entity_index, "");
          return;
        })
        .filter(Boolean);
      logger.log(
        `Getting DATA REDIS:  host(REDIS , ${host}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: {${entity}-${record_ids}}`
      );

      return {
        entity,
        record_ids,
      };
    });
    return (await result).flat();
  }

  async getDataElastic(host: string, entities: Array<Array<any>>) {
    const client = await this.createElasticClient(host);
    return map(entities, async ([entity, entity_count]) => {
      let progress_bar: string[] = [...new Array(10)].map((_e) => "*");
      let percentage = `0%`;
      const limit: number = this.batch_limit;
      let batches = Math.round(entity_count / limit);
      if (batches * limit < entity_count) batches += 1;
      let new_limit = limit;
      const percentage_bar: any = [];
      let total_retrieved_data: number = 0;

      const existing_elastic_ids_batched: any[] = await mapSeries(
        times(batches),
        async (batch) => {
          const current_batch = batch + 1;
          if (current_batch === batches)
            new_limit = entity_count - total_retrieved_data;
          const query = {
            match_all: {},
          };
          const index = `${DATABASE}_db_${SCHEMA_VERSION}-${entity}_v1`;
          const record_ids = await client
            .search({
              _source: ["id"],
              index,
              body: {
                query,
                size: new_limit,
                from: total_retrieved_data,
                track_total_hits: true,
              },
            })
            .then(({ hits: { hits } }) =>
              hits.map(({ _source: { id } }: any) => id)
            );

          const calc = (current_batch / batches) * 100;
          percentage = calc.toFixed(2) + "%";
          const rounded = Math.floor(calc);
          if (!percentage_bar.includes(rounded)) {
            percentage_bar.push(rounded);
          }
          const calculated_index = Math.round(rounded / 10);
          progress_bar[calculated_index] = `|`;
          total_retrieved_data += record_ids?.length ?? 0;

          logger.log(`[Progress]: ${total_retrieved_data}/${entity_count}`);
          logger.warn(`[${progress_bar.join("")}]  ${percentage}`);
          logger.warn(`[Batches]: ${current_batch}/${batches}`);
          logger.log(
            `RESULT ELASTIC: host(ELASTIC , ${host}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: {${entity} ${[
              record_ids,
            ]}}`
          );

          return record_ids;
        }
      );
      return {
        entity,
        record_ids: flatMapDeep(existing_elastic_ids_batched),
      };
    });
  }

  async getDataRethink(host: string, entities: Array<Array<any>>) {
    const client = await this.createRethinkClient(host.trim());
    return map(entities, async ([entity, entity_count]) => {
      let progress_bar: string[] = [...new Array(10)].map((_e) => "*");
      let percentage = `0%`;
      const limit: number = this.batch_limit;
      let batches = Math.round(entity_count / limit);
      if (batches * limit < entity_count) batches += 1;
      let new_limit = limit;
      const percentage_bar: any = [];
      let total_retrieved_data: number = 0;

      const existing_rethink_ids_batched = await mapSeries(
        times(batches),
        async (batch) => {
          const current_batch = batch + 1;
          if (current_batch === batches)
            new_limit = entity_count - total_retrieved_data;

          const record_ids = await client
            .db(RETHINK_DB)
            .table(entity)
            .pluck("id")
            .skip(total_retrieved_data)
            .limit(new_limit)
            .run()
            .then((result) => Object.values(result).map(({ id }) => id));

          const calc = (current_batch / batches) * 100;
          percentage = calc.toFixed(2) + "%";
          const rounded = Math.floor(calc);
          if (!percentage_bar.includes(rounded)) {
            percentage_bar.push(rounded);
          }
          const calculated_index = Math.round(rounded / 10);
          progress_bar[calculated_index] = `|`;
          total_retrieved_data += record_ids?.length ?? 0;

          logger.log(`[Progress]: ${total_retrieved_data}/${entity_count}`);
          logger.warn(`[${progress_bar.join("")}]  ${percentage}`);
          logger.warn(`[Batches]: ${current_batch}/${batches}`);
          logger.log(
            `RESULT RETHINK: host(RETHINK , ${host}), ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: {${entity} ${[
              record_ids,
            ]}}`
          );

          return record_ids;
        }
      );
      return {
        entity,
        record_ids: flatMapDeep(existing_rethink_ids_batched),
      };
    });
  }

  getOutOfSyncIds(
    backup_storage_data: Record<string, any>,
    target_storage_data: Record<string, any>,
    curr_out_of_sync_records: Record<string, any>
  ) {
    let out_of_sync_records: Record<string, any> = curr_out_of_sync_records;
    const reduced_reduced_reliable_data_ids = backup_storage_data.reduce(
      (acc: Record<string, any>, curr: Record<string, any>) => {
        const { entity, record_ids } = curr;
        return {
          ...acc,
          [entity]: {
            record_ids,
          },
        };
      },
      {}
    );
    target_storage_data.forEach((target_entity_data: Record<string, any>) => {
      const { entity, record_ids } = target_entity_data;
      out_of_sync_records = {
        ...out_of_sync_records,
        [entity]: [
          ...(out_of_sync_records[entity] ?? []),
          ...reduced_reduced_reliable_data_ids[entity]?.record_ids.filter(
            (item: string) =>
              !record_ids.includes(item) &&
              !out_of_sync_records[entity]?.includes(item)
          ),
        ],
      };
    });
    return out_of_sync_records;
  }

  async getAllCounts() {
    const redis_count = await this.getRedisDBCounts(this.redis_hosts);
    const backup_storage_count = await this.getRedisDBCounts([
      this.backup_storage_redis_host,
    ]);
    const elastic_count = await this.getElasticDBCounts(this.elastic_hosts);
    const rethink_count = await this.getRethinkDBCounts(this.rethink_hosts);
    const {
      total_data_count: backup_storage_total_count = 0,
      entity_counts: backup_storage_entity_counts = {},
    } = backup_storage_count[0];

    let out_of_sync_hosts: Array<Record<string, any>> = [];
    let out_of_sync_records: Record<string, any> = {};
    let max_count = backup_storage_total_count;
    let min_count = backup_storage_total_count;

    const {
      curr_min_count: redis_min_count,
      out_of_sync_records: redis_out_of_sync_records,
    } = await this.getOutOfSyncIdsPerHost(
      "redis",
      redis_count,
      backup_storage_entity_counts,
      min_count,
      out_of_sync_hosts,
      out_of_sync_records,
      {
        getBackupData: async (host: string, entities: Array<Array<any>>) =>
          this.getDataRedis(host, entities),
        getDataInCurrDB: async (host: string, entities: Array<Array<any>>) =>
          this.getDataRedis(host, entities),
        getOutOfSyncIds: async (
          backup_storage_data: Record<string, any>,
          target_storage_data: Record<string, any>,
          curr_out_of_sync_records: Record<string, any>
        ) =>
          this.getOutOfSyncIds(
            backup_storage_data,
            target_storage_data,
            curr_out_of_sync_records
          ),
      }
    );
    min_count = redis_min_count;
    out_of_sync_records = {
      ...out_of_sync_records,
      ...redis_out_of_sync_records,
    };
    const {
      curr_min_count: elastic_min_count,
      out_of_sync_records: elastic_out_of_sync_records,
    } = await this.getOutOfSyncIdsPerHost(
      "elastic",
      elastic_count,
      backup_storage_entity_counts,
      min_count,
      out_of_sync_hosts,
      out_of_sync_records,
      {
        getBackupData: async (host: string, entities: Array<Array<any>>) =>
          this.getDataRedis(host, entities),
        getDataInCurrDB: async (host: string, entities: Array<Array<any>>) =>
          this.getDataElastic(host, entities),
        getOutOfSyncIds: async (
          backup_storage_data: Record<string, any>,
          target_storage_data: Record<string, any>,
          curr_out_of_sync_records: Record<string, any>
        ) =>
          this.getOutOfSyncIds(
            backup_storage_data,
            target_storage_data,
            curr_out_of_sync_records
          ),
      }
    );
    min_count = elastic_min_count;
    out_of_sync_records = {
      ...out_of_sync_records,
      ...elastic_out_of_sync_records,
    };
    const {
      curr_min_count: rethink_min_count,
      out_of_sync_records: rethink_out_of_sync_records,
    } = await this.getOutOfSyncIdsPerHost(
      "rethink",
      rethink_count,
      backup_storage_entity_counts,
      min_count,
      out_of_sync_hosts,
      out_of_sync_records,
      {
        getBackupData: async (host: string, entities: Array<Array<any>>) =>
          this.getDataRedis(host, entities),
        getDataInCurrDB: async (host: string, entities: Array<Array<any>>) =>
          this.getDataRethink(host, entities),
        getOutOfSyncIds: async (
          backup_storage_data: Record<string, any>,
          target_storage_data: Record<string, any>,
          curr_out_of_sync_records: Record<string, any>
        ) =>
          this.getOutOfSyncIds(
            backup_storage_data,
            target_storage_data,
            curr_out_of_sync_records
          ),
      }
    );
    min_count = rethink_min_count;
    out_of_sync_records = {
      ...out_of_sync_records,
      ...rethink_out_of_sync_records,
    };
    let isSync = max_count === min_count;
    const status = isSync ? "DBs are synchronized." : "OUT OF SYNC";
    if (!isSync)
      await this.sendNotifToGlip(
        `Out of Sync Databases - ${DATABASE}_db_${SCHEMA_VERSION}`,
        "Re-Sync Service Notification",
        {
          database_maximum_data_count: max_count,
          database_minimum_data_count: min_count,
          status,
          out_of_sync_hosts,
        }
      );
    const res = {
      database: `${DATABASE}_db_${SCHEMA_VERSION}`,
      max_count,
      min_count,
      status,
      ["redis"]: redis_count,
      ["elastic"]: elastic_count,
      ["rethink"]: rethink_count,
      ["backup_storage"]: backup_storage_count,
      out_of_sync_hosts,
      out_of_sync_records,
    };
    logger.log(
      `Getting ALL COUNTS:  date: ${new Date().toISOString()}, user: ${ELASTIC_USERNAME}, results: {max_count:${max_count}, min_count:${min_count}, status:${
        res.status
      }}`
    );
    return res;
  }

  async sendNotifToGlip(
    title: string,
    activity: string = "Re-Sync Service Notification",
    message: AnyObject
  ) {
    const message_format = {
      activity,
      title,
      body: JSON.stringify(message),
    };
    const options = {
      method: "POST",
      uri: ERROR_LOG_WEB_HOOK_URL,
      body: message_format,
      json: true, // Automatically stringifies the body to JSON
    };

    await rp(options)
      .then(function (result: AnyObject) {
        logger.log(
          "Initializing - Glip Web Hook: ",
          JSON.stringify(result, null, 2)
        );
      })
      .catch(function (err: Error) {
        logger.log("Error - Glip Web Hook: ", JSON.stringify(err, null, 2));
      });
  }
}
