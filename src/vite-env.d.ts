/// <reference types="vite/client" />
// 文件说明：引入 Vite 提供的前端环境变量和资源类型声明。

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
