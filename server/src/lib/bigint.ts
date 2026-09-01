// 让 JSON.stringify 支持 BigInt（Prisma 的 sizeBytes 是 BigInt）
// 必须在任何 res.json() 之前执行
if (!(BigInt.prototype as unknown as { toJSON?: unknown }).toJSON) {
  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
    return this.toString();
  };
}

export {};
