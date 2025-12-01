import { FileSystem } from "@davidsouther/jiffies/lib/esm/fs.js";
import { NodeFileSystemAdapter } from "@davidsouther/jiffies/lib/esm/fs_node.js";
import { Err, isErr, unwrap } from "@davidsouther/jiffies/lib/esm/result.js";
import type { Assignment } from "@nand2tetris/projects/base.js";
import { compile } from "@nand2tetris/simulator/jack/compiler.js";
import { runner } from "@nand2tetris/simulator/projects/runner.js";
import { TST } from "@nand2tetris/simulator/languages/tst.js";
import { VM } from "@nand2tetris/simulator/languages/vm.js";
import { VMTest } from "@nand2tetris/simulator/test/vmtst.js";
import { Vm, type ParsedVmFile } from "@nand2tetris/simulator/vm/vm.js";
import { dirname, join, parse, resolve } from "path";
import type {
  TstCommand,
  TstFileOperation,
} from "@nand2tetris/simulator/languages/tst.js";

const VMSTEP_REGEX = /\bvmstep\b/i;

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "err" in error) {
    const err = (error as { err?: unknown }).err as
      | { message?: string }
      | undefined;
    if (err?.message) return err.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

interface VmSourceFile {
  name: string;
  content: string;
}

/**
 * Load an assignment using a provided tst string instead of reading from disk.
 */
async function loadAssignmentFromSource(
  fs: FileSystem,
  file: Assignment,
  tst: string,
) {
  const baseDir = file.dir || process.cwd();
  const hdl = await fs.readFile(join(baseDir, `${file.name}.hdl`));
  const cmp = await fs
    .readFile(join(baseDir, `${file.name}.cmp`))
    .catch(() => "" as string);
  return { ...file, hdl, tst, cmp };
}

/**
 * Run a nand2tetris.tst file.
 */
export async function testRunner(dir: string, file: string, tst: string) {
  const fs = new FileSystem(new NodeFileSystemAdapter());
  const tstPath = resolve(join(dir, `${file}.tst`));

  // If a VM test omits the standard boilerplate, prepend it so the script is valid.
  const base = parse(tstPath).name;
  const prelude: string[] = [];
  if (!/^\s*load\s+/im.test(tst)) {
    prelude.push(`load ${base}.vm,`);
  }
  if (!/^\s*compare-to\s+/im.test(tst)) {
    prelude.push(`compare-to ${base}.cmp,`);
  }
  const adjustedTst = prelude.length ? `${prelude.join("\n")}\n${tst}` : tst;
  const offset = prelude.length;

  if (VMSTEP_REGEX.test(adjustedTst)) {
    await runVmTest(fs, tstPath, adjustedTst, offset);
    return;
  }

  // Fallback to the HDL runner if this isn't a VM test.
  const assignment = await loadAssignmentFromSource(
    fs,
    parse(tstPath),
    adjustedTst,
  );
  if (assignment.dir) {
    fs.cd(assignment.dir);
  }
  const tryRun = runner(fs);
  const run = await tryRun(assignment);
  console.log(run);
}

/**
 * Run a chip HDL using a tst script passed as a string via stdin.
 */
export async function testRunnerFromSource(
  dir: string,
  file: string,
  tst: string,
) {
  let offset = 0;
  if (!tst.trimStart().startsWith("load ")) {
    tst = `load ${file},\n` + tst;
    offset = 1;
  }
  const fs = new FileSystem(new NodeFileSystemAdapter());
  const assignmentPath = parse(join(resolve(dir), `${file}.tst`));
  const assignment = await loadAssignmentFromSource(fs, assignmentPath, tst);
  if (assignment.dir) {
    fs.cd(assignment.dir);
  }
  const tryRun = runner(fs);
  const run = await tryRun(assignment);

  let errorMessage = "";
  // Print output to stdout or stderr based on pass/fail
  if (run.pass) {
    process.stdout.write(run.out);
  } else {
    // Check if these are error results (have 'err' property at top level)
    if ("err" in run.maybeParsedHDL && run.maybeParsedHDL.err) {
      errorMessage = run.maybeParsedHDL.err.message || "HDL parsing error";
    } else if ("err" in run.maybeParsedTST && run.maybeParsedTST.err) {
      errorMessage = run.maybeParsedTST.err.message || "TST parsing error";
    } else if ("err" in run.maybeChip && run.maybeChip.err) {
      errorMessage = run.maybeChip.err.message || run.maybeChip.err.toString();
    } else if ("err" in run.maybeTest && run.maybeTest.err) {
      errorMessage = run.maybeTest.err.message || run.maybeTest.err.toString();
    } else {
      // Fallback to out if no specific error found
      process.stdout.write(run.out);
    }

    // Write error message to stderr
    if (errorMessage) {
      if (offset) {
        errorMessage = errorMessage.replace(/Line\s+(\d+)/g, (_, l) => {
          const line = Number(l) - offset;
          return `Line ${line}`;
        });
      }
      process.stderr.write(errorMessage + "\n");
    }
  }

  // Exit with appropriate code
  process.exit(!errorMessage ? 0 : 1);
}

async function runVmTest(
  fs: FileSystem,
  tstPath: string,
  tst: string,
  offset: number,
) {
  try {
    const parsedTstResult = TST.parse(tst);
    if (isErr(parsedTstResult)) {
      throw Err(parsedTstResult);
    }
    const parsedTst = unwrap(parsedTstResult);
    const testDir = dirname(tstPath);
    let hasCmpFile = false;

    const isCompareTo = (
      command: TstCommand,
    ): command is TstCommand & { op: TstFileOperation } =>
      command.op.op === "compare-to";

    const compareCommand = parsedTst.lines
      .flatMap((line) =>
        "statements" in line ? (line.statements as TstCommand[]) : [line],
      )
      .find(isCompareTo);

    const compareFile = compareCommand?.op.file;

    // Check if cmp file exists in directory
    if (compareFile) {
      const cmpPath = join(testDir, compareFile);
      try {
        const stats = await fs.stat(cmpPath);
        hasCmpFile = stats.isFile();
      } catch (error) {
        hasCmpFile = false;
      }
    }

    const loadCompareFile = async (file?: string) => {
      if (!file || !hasCmpFile) {
        return;
      }
      const cmpPath = join(testDir, file);
      try {
        await fs.readFile(cmpPath);
      } catch (error) {
        throw new Error(
          `Unable to read compare file ${cmpPath}: ${(error as Error).message}`
        );
      }
    };

    const maybeTest = VMTest.from(parsedTst, {
      dir: tstPath,
      doEcho: (message) => console.log(message),
      compareTo: hasCmpFile ? loadCompareFile : undefined,
      doLoad: async (target) => {
        const resolvedTarget = target ?? testDir;
        const vm = await buildVmForTarget(fs, resolvedTarget);
        vmTest.with(vm);
      },
    });

    const vmTest = unwrap(maybeTest).using(fs);
    await vmTest.run();
    const out = vmTest.log();

    if (hasCmpFile) {
      const expectedCmp = await fs.readFile(join(testDir, compareFile ?? ""));
      const pass = expectedCmp ? out.trim() === expectedCmp.trim() : false;
      if (pass) {
        process.stdout.write(out);
        process.exit(0);
      } else {
        process.stdout.write(out);
        process.exit(1);
      }
    }else{ 
      process.stdout.write(out);
      process.exit(0);
    }
  } catch (error) {
    let errorMessage = messageFrom(error);
    if (offset) {
      errorMessage = errorMessage.replace(/Line\s+(\d+)/gi, (_, l) => {
        const line = Number(l) - offset;
        return `Line ${line}`;
      });
    }
    process.stderr.write(errorMessage + "\n");
    process.exit(1);
  }
}

async function buildVmForTarget(
  fs: FileSystem,
  targetPath: string,
): Promise<Vm> {
  const stats = await fs.stat(targetPath).catch(() => undefined);
  const loadDir = stats?.isDirectory() ? targetPath : dirname(targetPath);
  const sources = await collectVmSources(fs, loadDir);
  if (!sources.length) {
    throw new Error(
      `No .vm or .jack files found in ${loadDir} to execute this test.`,
    );
  }
  const parsed: ParsedVmFile[] = [];
  for (const source of sources) {
    const parsedVm = VM.parse(source.content);
    if (isErr(parsedVm)) {
      throw Err(parsedVm);
    }
    parsed.push({
      name: source.name,
      instructions: unwrap(parsedVm).instructions,
    });
  }
  const built = Vm.buildFromFiles(parsed);
  if (isErr(built)) {
    throw Err(built);
  }
  return unwrap(built);
}

async function collectVmSources(
  fs: FileSystem,
  dir: string,
): Promise<VmSourceFile[]> {
  const entries = await fs.scandir(dir).catch(() => []);
  const jackSources: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jack")) {
      const baseName = entry.name.replace(/\.jack$/, "");
      jackSources[baseName] = await fs.readFile(join(dir, entry.name));
    }
  }

  const vmSources: VmSourceFile[] = [];
  if (Object.keys(jackSources).length) {
    const compiled = compile(jackSources);
    const errors: string[] = [];
    for (const [name, compiledFile] of Object.entries(compiled)) {
      if (typeof compiledFile === "string") {
        vmSources.push({ name, content: compiledFile });
      } else {
        errors.push(compiledFile.message);
      }
    }
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".vm")) {
      const baseName = entry.name.replace(/\.vm$/, "");
      if (vmSources.some((source) => source.name === baseName)) {
        continue;
      }
      vmSources.push({
        name: baseName,
        content: await fs.readFile(join(dir, entry.name)),
      });
    }
  }

  return vmSources;
}

// export async function testDebugger(root: string, name: string, port: number) {}
