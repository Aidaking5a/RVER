import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 20_000;

export async function runProjectCheck(
  check: string,
  projectRoot = process.cwd(),
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  check: string;
  exitCode: number | null;
  output: string;
}> {
  // Only allow explicitly approved checks.
  if (check !== "typescript_build") {
    throw new Error("This project check is not allowed.");
  }

  const root = await realpath(projectRoot);
  const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");

  await access(compiler);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [compiler, "--noEmit"], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(key),
        ),
      ),
    });

    let output = "";
    let timedOut = false;

    function collect(chunk: Buffer): void {
      if (output.length < MAX_OUTPUT_CHARS) {
        output += chunk.toString().slice(0, MAX_OUTPUT_CHARS - output.length);
      }
    }

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      const success = code === 0 && !timedOut;

      resolve({
        success,
        check,
        exitCode: code,
        output: [
          timedOut ? "Check timed out after 30 seconds." : "",
          output ||
            (success
              ? "TypeScript check passed."
              : "No compiler output was produced."),
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, MAX_OUTPUT_CHARS),
      });
    });
  });
}
