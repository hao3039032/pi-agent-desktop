/**
 * The pi-web bridge extension, loaded into every `pi --mode rpc` child the
 * CLI engine spawns (`--extension <this file>`).
 *
 * pi's RPC protocol (1.4.0) has no commands for tree navigation or reload,
 * but extension COMMAND handlers receive an ExtensionCommandContext that
 * does: navigateTree (with summarize) and reload. These internal commands
 * are the wire for the wrapper's session-tree cases; the factory verifies
 * "pi-web:navigate" is registered after spawn, so a bridge that failed to
 * load fails the session loudly instead of the literal command text going
 * to the model.
 *
 * Keep this file self-contained plain JavaScript: it runs inside the pi
 * child, which does not share pi-web's module graph.
 */

export default function piWebBridge(pi) {
  pi.registerCommand("pi-web:navigate", {
    description: "pi-web internal: move the session's active leaf",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) throw new Error("pi-web:navigate requires an entry id");
      const entryId = parts[0];
      const summarize = parts.includes("--summarize");
      const instructionsStart = parts.indexOf("--instructions");
      const customInstructions = instructionsStart >= 0
        ? parts.slice(instructionsStart + 1).join(" ") || undefined
        : undefined;
      const result = await ctx.navigateTree(entryId, {
        ...(summarize ? { summarize: true } : {}),
        ...(customInstructions !== undefined ? { customInstructions } : {}),
      });
      if (result.cancelled) throw new Error("pi-web:navigate was cancelled");
      return "navigated";
    },
  });

  pi.registerCommand("pi-web:reload", {
    description: "pi-web internal: reload extensions, skills and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return "reloaded";
    },
  });
}
