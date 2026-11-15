import { NextResponse } from "next/server";
import { db, videos, randomUUID } from "@/lib/db";
import { desc } from "drizzle-orm";
import { z } from "zod";
export const runtime = "nodejs";
const createSchema = z.object({ topic: z.string().trim().min(8).max(2000), durationSeconds: z.number().int().min(1).max(3600), aspectRatio: z.enum(["9:16", "16:9"]), width: z.number().int().positive(), height: z.number().int().positive(), visualStyle: z.string(), language: z.enum(["English", "Hindi"]), imagePresetId: z.string(), videoPresetId: z.string(), fps: z.number().positive().default(30), subtitles: z.boolean().default(true), notes: z.string().max(2000).default("") });
export async function GET() { return NextResponse.json(db.select().from(videos).orderBy(desc(videos.createdAt)).all().map(v => ({ ...v, settings: JSON.parse(v.settings), production: v.production ? JSON.parse(v.production) : null }))); }
export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const now = Date.now(), id = randomUUID(), data = parsed.data;
  const record = { id, topic: data.topic, title: data.topic.split(/[.!?]/)[0].slice(0, 90), settings: JSON.stringify(data), status: "Awaiting Production JSON", production: null, createdAt: now, updatedAt: now };
  db.insert(videos).values(record).run();
  return NextResponse.json({ ...record, settings: data, production: null }, { status: 201 });
}
