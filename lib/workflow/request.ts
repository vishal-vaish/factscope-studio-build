import type { Production } from "@/lib/production-schema";
import type { ReferenceAnalysis } from "@/lib/workflow/inspect";

export type WorkflowModelSelection = { image: string; video: string };

export function buildWorkflowContext(production: Production, reference: ReferenceAnalysis, models: WorkflowModelSelection) {
  return {
    format: "factscope.workflow-context.v1",
    generatedAt: new Date().toISOString(),
    production,
    selectedModels: {
      image: { filename: models.image, verification: "Unverified until present in the connected ComfyUI /object_info." },
      video: { filename: models.video, verification: "Unverified until present in the connected ComfyUI /object_info." },
      textEncoders: reference.models.textEncoder,
      vaeModels: reference.models.vae,
      audioModels: reference.models.audio,
    },
    referenceWorkflow: reference,
    providedReferenceExample: { sceneCount: 10, durationSeconds: 50, fps: 24, narrationLanguage: "Hindi", source: "User-provided example in the request; confirm against the attached graph before treating it as extracted metadata." },
    executionCaveat: "ChatGPT-generated workflow files are untrusted inputs. FactScope must separately validate API node classes, input connections, models, configuration, and MP4 output against live ComfyUI /object_info before submission. Static compatibility checks do not prove a successful render.",
  };
}

export function buildWorkflowRequest(production: Production, reference: ReferenceAnalysis, models: WorkflowModelSelection) {
  const context = buildWorkflowContext(production, reference, models);
  const nodeSummary = reference.nodes.slice(0, 100).map(node => `${node.id}: ${node.type}${node.title ? ` (${node.title})` : ""}${node.category.length ? ` [${node.category.join(", ")}]` : ""}`).join("\n") + (reference.nodes.length > 100 ? `\n… ${reference.nodes.length - 100} additional nodes are detailed in the context JSON; attach the original workflow for its full structure.` : "");
  const measurementSummary = reference.measurements.length ? reference.measurements.map(item => `Node ${item.nodeId} ${item.input}: ${item.value} (${item.type})`).join("\n") : "No explicit FPS or duration values could be determined from named workflow inputs/properties.";
  const encoderSummary = reference.models.textEncoder.length ? reference.models.textEncoder.join(", ") : "No text encoder filename was identified; inspect the attached workflow and report missing dependencies.";
  const vaeSummary = reference.models.vae.length ? reference.models.vae.join(", ") : "No VAE filename was identified; inspect the attached workflow and report missing dependencies.";
  const edges = reference.links.slice(0, 100).map(link => `${link.fromNodeId}:${link.fromSlot ?? "?"} → ${link.toNodeId}:${link.toSlot ?? "?"}${link.type ? ` (${link.type})` : ""}`).join("\n");
  const sceneSummary = production.scenes.map(scene => `Scene ${scene.order} (${scene.startSeconds}-${scene.startSeconds + scene.durationSeconds}s): ${scene.title}`).join("\n");
  const exampleDifference = `The user-provided example reference is described as 10 scenes, 50 seconds, 24 FPS, and Hindi narration (verify those details against the attached file). This Production JSON instead requests ${production.scenes.length} scenes, ${production.video.durationSeconds} seconds, ${production.video.fps} FPS, and ${production.narration.language} narration.`;
  return `You are an expert ComfyUI workflow analyst and science-video pipeline designer. First inspect the attached original editable ComfyUI workflow file named "${reference.filename}". Do not create a graph until you have identified its actual node types, connections, model loaders, prompts, audio/video assembly stages, and output node. The node inventory and links below are a guide extracted from the file; the original attachment is authoritative.

TASK
Adapt the reference workflow to the complete FactScope Production JSON below. Produce both requested workflow files, but do not claim they are valid or tested. Use only node types, input names, model capabilities, and connections supported by the reference graph or explicitly verified ComfyUI documentation/capabilities. If a required stage or dependency is absent or ambiguous, explain the limitation and leave it unimplemented rather than inventing custom nodes or capabilities.

PROJECT TARGET
- Scene count: ${production.scenes.length}
- Total duration: ${production.video.durationSeconds} seconds
- Target FPS: ${production.video.fps}
- Target export resolution: ${production.video.width} × ${production.video.height} (${production.video.aspectRatio})
- Narration language: ${production.narration.language}; audio language: ${production.audio.language}
- Reference-vs-project difference: ${exampleDifference}
- Target MP4: one complete final MP4
- Scene timeline:
${sceneSummary}

SELECTED MODELS (provided by the user; installation is not verified)
- Image: ${models.image}
- Video: ${models.video}
- Text encoders retained from the reference: ${encoderSummary}
- VAE dependencies retained from the reference: ${vaeSummary}
- Other audio model files detected: ${reference.models.audio.join(", ") || "None identified"}

REFERENCE WORKFLOW
- Original filename: ${reference.filename}
- Format: editable ComfyUI UI workflow JSON (not API execution format)
- Nodes: ${reference.nodeCount}; links: ${reference.linkCount}
- Existing explicit measurements:
${measurementSummary}
- Node IDs, types, and detected stages:
${nodeSummary || "No nodes were detected."}
- First ${Math.min(reference.links.length, 100)} connections:
${edges || "No connections were detected."}
- Detected workflow stages: ${Object.entries(reference.categories).filter(([, ids]) => ids.length).map(([category, ids]) => `${category}: ${ids.join(", ")}`).join("; ") || "No stage categories could be identified confidently."}

REQUIRED TRANSFORMATIONS
1. Analyze the attached reference graph before editing. Reuse its real node types and compatible connections; preserve its model loaders, required text encoders/VAE, verified audio-generation and audio-concatenation stages, frame/video concatenation, and final video-output stage when present.
2. Replace old image prompts and video-motion prompts with the corresponding prompts from the new Production JSON. Adapt the graph to its ${production.scenes.length} scenes, preserving their order and complete timeline; do not retain old scene prompts.
3. Preserve subject identity, canonical description, fixed properties, continuity, and scientific constraints. Keep narration and spoken dialogue in ${production.narration.language}; do not reuse the reference workflow's old dialogue language.
4. Recalculate frame counts and clip durations from the Production JSON at the requested ${production.video.fps} FPS. The reference's native FPS and resolution are not assumed to support the requested values. The ${production.video.width}×${production.video.height} setting is the requested export resolution, not proof of native model generation resolution. Explain any required upscale, resampling, or unsupported setting instead of silently changing it.
5. Verify the graph's scene continuity, dependency connections, frame/audio assembly, and exactly one final MP4 output node. Do not submit scenes as separate jobs.
6. Do not invent custom nodes, input names, model support, or guaranteed compatibility. Explain every missing capability, dependency, or uncertainty. Do not state that either workflow was tested or executed unless it actually was.

OUTPUT FILES
Return exactly two complete JSON files as separate downloadable attachments, with no omitted nodes or placeholder ellipses:
1. factscope_master_workflow.json — editable ComfyUI UI-format graph containing nodes, links, widgets_values, and properties.
2. factscope_master_workflow_api.json — ComfyUI API execution-format node map containing class_type and inputs.
Also give a concise compatibility/limitations report. The UI graph and API graph must describe the same complete workflow. Valid JSON alone does not establish compatibility; FactScope will validate the API graph against the connected ComfyUI /object_info before submission.

COMPLETE FACTSCOPE PRODUCTION JSON
\`\`\`json
${JSON.stringify(production, null, 2)}
\`\`\`

Workflow context JSON is available separately as "Download Workflow Context JSON". Keep this request readable; use the attached original workflow rather than pasting or summarizing away its full graph.`;
}
