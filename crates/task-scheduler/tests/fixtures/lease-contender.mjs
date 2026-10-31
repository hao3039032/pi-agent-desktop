import { createJiti } from "jiti";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const jiti = createJiti(import.meta.url);
const { acquireLease } = await jiti.import(resolve(process.argv[2], "lib/scheduled-tasks/lease.ts"));
const won = acquireLease(resolve(process.argv[3], "scheduled-tasks"), {
  pid: 123,
  now: new Date(Number(process.argv[4])),
  alive: () => true,
});
writeFileSync(process.argv[5], String(won));
