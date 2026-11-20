## 注意事项
- 每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。
- 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。

## 服务端数据库（PostgreSQL）
- 服务端主库是 PostgreSQL（pg 驱动 + Pool），连接串走 `DATABASE_URL`；repo/service 层全部异步，事务用 `withTx(db, async (tx) => ...)`，**闭包内查询必须传 tx**，传外层 Pool 会脱离事务导致并发数据错乱。
- SQL 保持 `?` 占位符写法，由 db/index.ts 的 all/one/run helper 自动转 `$n`；不要手写 `$1`。
- 全文搜索不用 PG 原生 tsvector，走 `pg_trgm` GIN 索引加速的 `ILIKE`（迁移 0007）；用户可见的搜索一律 ILIKE，不用 LIKE。
- 测试用 embedded-postgres（test/global-pg.ts，端口 54329）拉起内嵌 PG，每个测试文件一个独立数据库；新测试文件建库前先在 test 目录放好，命名冲突时改 global-pg 的派生规则。
- 历史数据迁移脚本：`apps/server/scripts/migrate-sqlite-to-pg.mjs`（旧 SQLite 库 → 新 PG 库，只对空库跑一次）。
- `INTEGER` 列在 PG 里是 32 位，毫秒时间戳必须用 `BIGINT`；pg 的 int8 已在 db/index.ts 统一解析回 number。

## 安卓工程
- `apps/desktop/src-tauri/gen/android` 大部分由 Tauri 生成后忽略，只有三个文件手工维护并纳入版本管理：`app/build.gradle.kts`、`app/src/main/AndroidManifest.xml`、`app/src/main/java/com/nenochat/app/MainActivity.kt`（后两个因位于被忽略的深层目录，用 `git add -f` 跟踪）。
- 任何 `tauri android init` 都会重建整个工程并覆盖上面三个文件，执行后必须从 git 还原，否则会丢掉局域网权限声明、权限桥与边到边布局。`release-build.yml` 里的还原清单要同步更新。
