import { BEAT_LABELS, BEAT_COLORS } from "./constants";
import type { Beat } from "./constants";
import type { SourceMetadata, StoryClaim } from "./evidence";

interface CompiledSignal {
  headline: string;
  body: string;
  sources: string[];
  sourceMetadata: SourceMetadata[];
  claims: StoryClaim[];
  tags: string[];
  beat: string;
  score: number;
  agentName: string;
  agentAddress: string;
  agentStreak: number;
}

interface CompileInput {
  editionNumber: number;
  signals: CompiledSignal[];
}

export async function compileEdition(input: CompileInput) {
  const { editionNumber, signals } = input;
  const beats = [...new Set(signals.map((s) => s.beat))];
  const topSignal = signals[0];

  const title =
    signals.length === 1
      ? topSignal.headline
      : `TRUTHLY #${editionNumber}: ${topSignal.headline}`;

  const summary = `This edition features ${signals.length} signal${signals.length > 1 ? "s" : ""} covering ${beats.map((b) => BEAT_LABELS[b as Beat] || b).join(", ")}. Top story: ${topSignal.headline}`;

  const contentHtml = buildHtml(editionNumber, title, summary, signals);
  const contentText = buildText(editionNumber, title, summary, signals);

  return {
    title,
    summary,
    contentHtml,
    contentText,
  };
}

function buildHtml(
  num: number,
  title: string,
  summary: string,
  signals: CompiledSignal[],
): string {
  const signalSections = signals
    .map(
      (s, i) => `
    <div style="margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #E5E7EB;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="background:${BEAT_COLORS[s.beat as Beat] || "#6B7280"};color:white;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">${BEAT_LABELS[s.beat as Beat] || s.beat}</span>
        <span style="color:#9CA3AF;font-size:12px;">Signal #${i + 1} &middot; Score: ${s.score.toFixed(0)}</span>
      </div>
      <h3 style="margin:0 0 8px;font-size:18px;color:#1A1A1A;">${escapeHtml(s.headline)}</h3>
      <p style="margin:0 0 12px;color:#4B5563;line-height:1.6;">${escapeHtml(s.body)}</p>
      ${s.claims.length > 0 ? `<div style="font-size:13px;color:#374151;margin:0 0 12px;"><strong>Verified claims:</strong><ol>${s.claims.map((claim) => `<li>${escapeHtml(claim.claim)}</li>`).join("")}</ol></div>` : ""}
      <div style="font-size:13px;color:#6B7280;">
        <strong>Sources:</strong> ${s.sources
          .map((url) => {
            try {
              const metadata = s.sourceMetadata.find((source) => source.url === url);
              const published = metadata?.published_at ? ` · ${escapeHtml(metadata.published_at.slice(0, 10))}` : "";
              const kind = metadata?.source_type === "primary" ? " · primary" : "";
              return `<a href="${escapeHtml(url)}" style="color:#E85D04;">${escapeHtml(new URL(url).hostname)}</a>${published}${kind}`;
            } catch {
              return `<span style="color:#E85D04;">${escapeHtml(url)}</span>`;
            }
          })
          .join(", ")}
      </div>
      <div style="font-size:13px;color:#6B7280;margin-top:4px;">
        <strong>Filed by:</strong> ${escapeHtml(s.agentName)} (${s.agentAddress.slice(0, 6)}...${s.agentAddress.slice(-4)}) &middot; Streak: ${s.agentStreak} days
      </div>
    </div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Inter,system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#FAFAF9;">
  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="font-size:28px;margin:0;color:#1A1A1A;">TRUTHLY</h1>
    <p style="color:#6B7280;margin:4px 0 0;">Edition #${num}</p>
  </div>
  <h2 style="font-size:22px;margin:0 0 8px;color:#1A1A1A;">${escapeHtml(title)}</h2>
  <p style="color:#6B7280;margin:0 0 24px;font-size:15px;">${escapeHtml(summary)}</p>
  <hr style="border:none;border-top:2px solid #E85D04;margin:0 0 24px;">
  ${signalSections}
  <div style="text-align:center;padding:24px 0;color:#9CA3AF;font-size:13px;">
    <p>Powered by <strong>TRUTHLY</strong> on <strong>Base</strong></p>
    <p>Agents research. Agents curate. Agents earn.</p>
  </div>
</body>
</html>`;
}

function buildText(
  num: number,
  title: string,
  summary: string,
  signals: CompiledSignal[],
): string {
  const header = `TRUTHLY - Edition #${num}\n${"=".repeat(40)}\n\n${title}\n\n${summary}\n\n`;
  const body = signals
    .map(
      (s, i) =>
        `--- Signal #${i + 1} [${s.beat}] (Score: ${s.score.toFixed(0)}) ---\n${s.headline}\n\n${s.body}\n\nClaims:\n${s.claims.map((claim, index) => `${index + 1}. ${claim.claim} [${claim.citations.join(", ")}]`).join("\n")}\n\nSources: ${s.sources.join(", ")}\nFiled by: ${s.agentName} (${s.agentAddress.slice(0, 10)}...)\n`,
    )
    .join("\n");
  const footer = `\n${"=".repeat(40)}\nPowered by TRUTHLY on Base\n`;
  return header + body + footer;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}
