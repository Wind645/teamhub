import { spawn } from "node:child_process";

export async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string; signal: AbortSignal; timeout: number; limit: number;
    input?: string; shell?: boolean; env?: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; failure?: string }> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, shell: options.shell, env: options.env,
      windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: string | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      if (child.pid && process.platform === "win32") {
        const kill = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore",
        });
        kill.on("error", () => child.kill());
        kill.on("exit", code => { if (code !== 0) child.kill(); });
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const abort = () => stop("Cancelled");
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("Process timeout"), options.timeout);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    };
    const output: Buffer[][] = [[], []];
    let size = 0;
    [child.stdout, child.stderr].forEach((stream, index) => stream.on("data", (chunk: Buffer) => {
      const room = Math.max(0, options.limit - size);
      if (room) output[index].push(chunk.subarray(0, room));
      size += chunk.length;
      if (size > options.limit) stop("Output limit exceeded");
    }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", exitCode => {
      cleanup();
      resolve({
        stdout: Buffer.concat(output[0]).toString("utf8"),
        stderr: Buffer.concat(output[1]).toString("utf8"),
        exitCode, failure,
      });
    });
  });
}
