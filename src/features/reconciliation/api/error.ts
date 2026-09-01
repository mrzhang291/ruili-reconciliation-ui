// 文件说明：封装接口错误信息，方便页面统一展示错误原因和请求编号。
export class ReconciliationApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly requestId?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ReconciliationApiError";
  }
}
