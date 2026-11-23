use tauri_plugin_sql::{Migration, MigrationKind};

/// 客户端本地库的连接串，必须与 tauri.conf.json 中 plugins.sql.preload 完全一致。
pub const DB_URL: &str = "sqlite:nenochat.db";

/// 迁移只增不改：已应用过的 version 不会重跑，新版本必须追加新的 Migration。
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init_local_mirror",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "ai_persona_meta",
            sql: include_str!("../migrations/0002_ai_persona_meta.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "ai_proactive_mode",
            sql: include_str!("../migrations/0003_ai_proactive_mode.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "notification_index",
            sql: include_str!("../migrations/0004_notifications.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "member_notification_level",
            sql: include_str!("../migrations/0005_member_notification_level.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "drop_notifications",
            sql: include_str!("../migrations/0006_drop_notifications.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "drop_channels",
            sql: include_str!("../migrations/0007_drop_channels.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "drafts_dedupe",
            sql: include_str!("../migrations/0008_drafts_dedupe.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "persona_sticker_packs",
            sql: include_str!("../migrations/0009_persona_sticker_packs.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "ai_persona_relationship",
            sql: include_str!("../migrations/0010_ai_persona_relationship.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
