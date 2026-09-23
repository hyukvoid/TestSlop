import { spawn } from "node:child_process";

export interface TestRunResult {
  code: number | null;
  out: string;
  timedOut: boolean;
}

export interface TestSummary {
  passed: number;
  total: number;
}

/** Run a project-owned test command in the supplied working directory. */
export function runTestCommand(command: string, cwd: string, timeoutMs: number): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const chunks: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, out: chunks.join(""), timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => chunks.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => chunks.push(data.toString()));
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: chunks.join(""), timedOut: false });
    };
    child.on("close", finish);
    child.on("error", () => finish(1));
  });
}

/** Read common test-runner summaries without making a runner's wording part of the UX. */
export function parseTestSummary(output: string): TestSummary | undefined {
  const vitest = /(?:^|\n)\s*Tests?\s+(\d+)\s+passed(?:\s*\((\d+)\))?/i.exec(output);
  if (vitest?.[1]) {
    const passed = Number(vitest[1]);
    return { passed, total: Number(vitest[2] ?? vitest[1]) };
  }

  const jest = /(?:^|\n)\s*Tests:\s*(\d+)\s+passed,\s*(\d+)\s+total\b/i.exec(output);
  if (jest?.[1] && jest[2]) return { passed: Number(jest[1]), total: Number(jest[2]) };

  const node = /(?:^|\n)\s*[#ℹ]\s*tests\s+(\d+)[\s\S]*?(?:^|\n)\s*[#ℹ]\s*pass\s+(\d+)(?:[\s\S]*?(?:^|\n)\s*[#ℹ]\s*fail\s+0)?/im.exec(output);
  if (node?.[1] && node[2]) return { passed: Number(node[2]), total: Number(node[1]) };

  const mocha = /(?:^|\n)\s*(\d+)\s+passing\b/i.exec(output);
  if (mocha?.[1]) return { passed: Number(mocha[1]), total: Number(mocha[1]) };

  const ava = /(?:^|\n)\s*(\d+)\s+tests? passed\b/i.exec(output);
  if (ava?.[1]) return { passed: Number(ava[1]), total: Number(ava[1]) };

  return undefined;
}
