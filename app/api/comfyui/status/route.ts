import { NextResponse } from "next/server";
import { db, settings } from "@/lib/db";
import { eq } from "drizzle-orm";
import { requireLocalHost } from "@/lib/comfyui/request-guard";
import { comfyConfig } from "@/lib/comfyui/config";
export const runtime = "nodejs";
export async function GET(request: Request) { const blocked = requireLocalHost(request); if (blocked) return NextResponse.json({ connected: false, message: blocked }, { status: 403 }); const rows = Object.fromEntries(db.select().from(settings).all().map(r => [r.key, JSON.parse(r.value)])); const endpoint = rows.endpoint || comfyConfig.endpoint; try { const url = new URL("/system_stats", endpoint); const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: rows.token ? { Authorization: `Bearer ${rows.token}` } : {} }); if (!response.ok) return NextResponse.json({ connected: false, message: `ComfyUI returned HTTP ${response.status}.` }); const stats = await response.json(); return NextResponse.json({ connected: true, message: "ComfyUI is reachable.", stats }); } catch (error) { return NextResponse.json({ connected: false, message: error instanceof Error ? error.message : "Connection failed." }); } }
