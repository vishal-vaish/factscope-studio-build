import { NextResponse } from "next/server";
import { db, jobs } from "@/lib/db";
import { eq } from "drizzle-orm";
import { fetchOutput, getComfySettings, getJobOutput, isVerifiedMp4Response } from "@/lib/comfyui/client";
import { requireLocalHost } from "@/lib/comfyui/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const blocked = requireLocalHost(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { jobId } = await params;
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const output = getJobOutput(jobId);
  if (!output || job.status !== "completed") return NextResponse.json({ error: "The verified final MP4 is not available yet." }, { status: 409 });
  try {
    const { endpoint, token } = getComfySettings();
    const response = await fetchOutput(output, endpoint, token);
    if (!isVerifiedMp4Response(output, response)) {
      await response.body?.cancel();
      return NextResponse.json({ error: `ComfyUI final output is unavailable or is not an MP4 (HTTP ${response.status}).` }, { status: 502 });
    }
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${output.filename.split(/[\\/]/).pop()?.replace(/["\r\n]/g, "_") || "factscope-video.mp4"}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not retrieve final MP4." }, { status: 502 });
  }
}
