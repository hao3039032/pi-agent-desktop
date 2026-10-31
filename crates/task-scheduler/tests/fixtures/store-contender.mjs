import { createJiti } from "jiti";
import { resolve } from "node:path";
const jiti = createJiti(import.meta.url);
const { mutateTasks } = await jiti.import(resolve(process.argv[2], "lib/scheduled-tasks/store.ts"));
for (let i = 0; i < 20; i++) {
  const id = `11111111-1111-1111-1111-${String(i).padStart(12, "0")}`;
  mutateTasks((tasks) => ({ tasks: [...tasks, {
    id, name: `ts-${i}`, prompt: "fixture", cwd: process.argv[3],
    enabled: true, schedule: { kind: "manual" },
  }], result: null }), process.argv[3]);
}
