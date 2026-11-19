## 注意事项
- 每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。
- 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。

## 安卓工程
- `apps/desktop/src-tauri/gen/android` 大部分由 Tauri 生成后忽略，只有三个文件手工维护并纳入版本管理：`app/build.gradle.kts`、`app/src/main/AndroidManifest.xml`、`app/src/main/java/com/nenochat/app/MainActivity.kt`（后两个因位于被忽略的深层目录，用 `git add -f` 跟踪）。
- 任何 `tauri android init` 都会重建整个工程并覆盖上面三个文件，执行后必须从 git 还原，否则会丢掉局域网权限声明、权限桥与边到边布局。`release-build.yml` 里的还原清单要同步更新。
