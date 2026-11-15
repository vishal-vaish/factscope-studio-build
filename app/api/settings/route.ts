import { NextResponse } from "next/server";
import { db, settings } from "@/lib/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
export const runtime = "nodejs";
export async function GET() { const rows = db.select().from(settings).all(); return NextResponse.json(Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]))); }
export async function POST(request: Request) { const body = z.object({ endpoint: z.string().url(), token: z.string().max(500).optional() }).safeParse(await request.json()); if (!body.success) return NextResponse.json({ error: "Enter a valid ComfyUI endpoint." }, { status: 400 }); const endpoint = new URL(body.data.endpoint); if (!(["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname) || endpoint.hostname.endsWith(".local") || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(endpoint.hostname))) return NextResponse.json({ error: "For safety, FactScope only connects to localhost or a private local-network ComfyUI host." }, { status: 400 });
 for (const [key, value] of Object.entries({ endpoint: endpoint.origin, token: body.data.token || "" })) { db.insert(settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value) } }).run(); } return NextResponse.json({ ok: true }); }
