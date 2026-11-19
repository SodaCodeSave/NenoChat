/// <reference types="vite/client" />

/** 构建时由 Vite 注入的客户端版本 */
declare const __APP_VERSION__: string

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
