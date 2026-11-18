import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { EvalCase } from "./case.ts";

/** Усі кейси з теки. Невалідний YAML — помилка з іменем файлу і шляхом до поля. */
export function loadCases(dir: string): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const r = EvalCase.safeParse(parse(readFileSync(join(dir, f), "utf8")));
      if (!r.success) throw new Error(`${f}:\n${z.prettifyError(r.error)}`);
      if (`${r.data.id}.yaml` !== f) throw new Error(`${f}: id «${r.data.id}» не збігається з іменем файлу`);
      return r.data;
    });
}
