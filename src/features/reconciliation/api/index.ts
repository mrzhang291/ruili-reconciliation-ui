// 文件说明：对账接口统一出口，根据环境变量选择后端 HTTP 接口或禁用态接口。
import { HttpReconciliationApi } from "./http-client";
import { DisabledReconciliationApi } from "./disabled-client";
import type { ReconciliationApi } from "./types";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3001").trim();

export const usingDisabledApi = !apiBaseUrl;

export const reconciliationApi: ReconciliationApi = !usingDisabledApi
  ? new HttpReconciliationApi({ baseUrl: apiBaseUrl })
  : new DisabledReconciliationApi();

export type { ReconciliationApi } from "./types";
export { ReconciliationApiError } from "./error";
