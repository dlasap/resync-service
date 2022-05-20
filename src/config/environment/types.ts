export default interface IEnvConfig {
  service_id: number;
  port: number;
  basic_auth_username: string;
  basic_auth_password: string;
  redis_http_host: string;
  elastic_search_http_host: string;
  schema_version: string;
  app_environment: string;
  graphql_endpoint_timeline: string;
  enable_restrictions: string;
  error_log_web_hook_url: string;
  gql_debug: string;
  gql_playground: string;
  [key: string]: any;
}
