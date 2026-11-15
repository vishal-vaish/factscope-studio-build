import "server-only";

function isPrivateHostname(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".local")) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) return true;
  return (process.env.FACTSCOPE_TRUSTED_HOSTS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean).includes(host);
}

export function requireLocalHost(request: Request) {
  const host = request.headers.get("host");
  if (!host) return "A local or explicitly trusted private server host is required.";
  try {
    if (!isPrivateHostname(new URL(`http://${host}`).hostname)) return "This endpoint is available only from a local or explicitly trusted private server host.";
  } catch { return "Invalid request host."; }
  return null;
}

export function requireLocalSameOrigin(request: Request) {
  const hostFailure = requireLocalHost(request);
  if (hostFailure) return hostFailure;
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!host || !origin) return "A same-origin browser request is required for local generation.";
  let originUrl: URL;
  try { originUrl = new URL(origin); } catch { return "Invalid request origin."; }
  if (originUrl.host.toLowerCase() !== host.toLowerCase()) return "Cross-origin generation requests are not allowed.";
  return null;
}
