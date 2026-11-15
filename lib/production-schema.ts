import { z } from "zod";

const stringList = z.array(z.string().min(1));
export const productionSchema = z.object({
  schemaVersion: z.literal("1.0.0"), documentType: z.literal("factscope.production"), projectId: z.string().uuid(), title: z.string().min(1),
  video: z.object({ durationSeconds: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(), aspectRatio: z.enum(["9:16", "16:9"]), visualStyle: z.string().min(1) }),
  models: z.object({ imagePresetId: z.string(), videoPresetId: z.string(), workflowTemplateId: z.string() }),
  narration: z.object({ language: z.string().min(1), fullScript: z.string(), segments: z.array(z.object({ startSeconds: z.number().nonnegative(), durationSeconds: z.number().positive(), text: z.string().min(1) })).default([]) }),
  continuity: z.object({ mainObject: z.string(), canonicalDescription: z.string(), fixedProperties: stringList, mechanicalConstraints: stringList, forbiddenChanges: stringList }),
  scenes: z.array(z.object({ id: z.string().min(1), order: z.number().int().positive(), title: z.string(), startSeconds: z.number().nonnegative(), durationSeconds: z.number().positive(), narration: z.string(), imagePrompt: z.string(), imageNegativePrompt: z.string(), videoPrompt: z.string(), videoNegativePrompt: z.string(), cameraMovement: z.string(), lighting: z.string(), firstFrame: z.string(), lastFrame: z.string(), continuityRules: stringList, scientificConstraints: stringList })).min(1),
  audio: z.object({ language: z.string(), voicePresetId: z.string().nullable(), subtitlesEnabled: z.boolean(), backgroundMusic: z.boolean() }),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.scenes.forEach((scene, index) => {
    if (ids.has(scene.id)) ctx.addIssue({ code: "custom", path: ["scenes", index, "id"], message: `Duplicate scene ID: ${scene.id}` });
    ids.add(scene.id);
    if (scene.order !== index + 1) ctx.addIssue({ code: "custom", path: ["scenes", index, "order"], message: `Scene order must be ${index + 1}.` });
    if (Math.abs(scene.startSeconds - value.scenes.slice(0, index).reduce((n, prior) => n + prior.durationSeconds, 0)) > 0.05) ctx.addIssue({ code: "custom", path: ["scenes", index, "startSeconds"], message: "Scene timeline must be continuous with no gaps or overlaps." });
  });
  const duration = value.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  if (Math.abs(duration - value.video.durationSeconds) > 0.05) ctx.addIssue({ code: "custom", path: ["scenes"], message: `Scene total (${duration}s) must equal video duration (${value.video.durationSeconds}s).` });
});
export type Production = z.infer<typeof productionSchema>;
