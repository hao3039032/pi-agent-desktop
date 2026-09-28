import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { initDistro } from "@/lib/distro";

export async function registerNodeInstrumentation(): Promise<void> {
  configureHttpDispatcher();
  // Fork: distribution overlay (bundled npm/Git Bash on PATH, pre-installed packages).
  await initDistro();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
