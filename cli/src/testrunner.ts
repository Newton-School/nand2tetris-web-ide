import { FileSystem } from "@davidsouther/jiffies/lib/esm/fs.js";
import { NodeFileSystemAdapter } from "@davidsouther/jiffies/lib/esm/fs_node.js";
import { runner } from "@nand2tetris/simulator/projects/runner.js";
import { Assignments } from "@nand2tetris/projects/full.js";
import type { Assignment } from "@nand2tetris/projects/base.js";
import { parse } from "path";

/**
 * Load an assignment from the local folder.
 * Uses built in assignments when the local tests are missing.
 */
async function loadAssignment(
  fs: FileSystem,
  file: Assignment,
  compare = true,
) {
  const assignment = Assignments[file.name as keyof typeof Assignments];
  const hdl = await fs.readFile(`${file.name}.hdl`);
  const tst = await fs
    .readFile(`${file.name}.tst`)
    .catch(
      () => assignment[`${file.name}.tst` as keyof typeof assignment] as string,
    );
  const cmp = compare
    ? await fs
        .readFile(`${file.name}.cmp`)
        .catch(
          () =>
            assignment[`${file.name}.cmp` as keyof typeof assignment] as string,
        )
    : "";

  return { ...file, hdl, tst, cmp };
}

/**
 * Run a nand2tetris.tst file.
 */
export async function testRunner(dir: string, file: string, compare = true) {
  const fs = new FileSystem(new NodeFileSystemAdapter());
  fs.cd(dir);
  const assignment = await loadAssignment(fs, parse(file), compare);
  const tryRun = runner(fs);
  const run = await tryRun(assignment);
  if (compare) {
    console.log(run);
  } else {
    console.log(run.out);
  }
}

// export async function testDebugger(root: string, name: string, port: number) {}
