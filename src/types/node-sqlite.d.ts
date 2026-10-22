// 最小化的 node:sqlite 类型声明（Node 22 的实验模块在 @types/node 中尚不稳定）。
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    exec(sql: string): void;
    close(): void;
  }
}
