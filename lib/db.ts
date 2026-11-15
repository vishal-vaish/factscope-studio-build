import "server-only";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const videos = sqliteTable("videos", { id: text("id").primaryKey(), title: text("title").notNull(), topic: text("topic").notNull(), settings: text("settings").notNull(), status: text("status").notNull(), production: text("production"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull() });
export const jobs = sqliteTable("generation_jobs", { id: text("id").primaryKey(), videoId: text("video_id").notNull(), status: text("status").notNull(), promptId: text("prompt_id"), error: text("error"), output: text("output"), createdAt: integer("created_at").notNull() });
export const settings = sqliteTable("app_settings", { key: text("key").primaryKey(), value: text("value").notNull() });
const dataDir = process.env.FACTSCOPE_DATA_DIR || join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const sqlite = new Database(join(dataDir, "factscope.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, topic TEXT NOT NULL, settings TEXT NOT NULL, status TEXT NOT NULL, production TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS generation_jobs (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, status TEXT NOT NULL, prompt_id TEXT, error TEXT, output TEXT, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
try { sqlite.exec("ALTER TABLE generation_jobs ADD COLUMN output TEXT"); } catch { /* Existing installations already have this column. */ }
export const db = drizzle(sqlite);
export { randomUUID };
