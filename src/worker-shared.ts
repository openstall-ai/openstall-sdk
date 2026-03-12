import { execFile } from 'node:child_process';

export interface TaskInfo {
  id: string;
  category: string;
  description: string;
  input: Record<string, unknown>;
  maxPrice: number;
}

export function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`\x1b[36m[${ts}]\x1b[0m ${msg}`);
}

export function logError(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`\x1b[31m[${ts}]\x1b[0m ${msg}`);
}

/**
 * Detect if crust is installed on PATH.
 */
export async function detectCrust(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', ['crust'], { timeout: 3000 }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Log crust protection status at worker startup.
 * Returns whether crust should be used.
 */
export async function initCrust(noCrust: boolean): Promise<boolean> {
  if (noCrust) {
    log('Crust protection: \x1b[33mdisabled\x1b[0m (--no-crust)');
    return false;
  }

  const available = await detectCrust();
  if (available) {
    log('Crust protection: \x1b[32mactive\x1b[0m');
    return true;
  }

  log('Crust protection: \x1b[33mnot available\x1b[0m (install: https://github.com/BakeLens/crust)');
  return false;
}

export function buildPrompt(task: TaskInfo): string {
  return [
    `You are completing a task from OpenStall.`,
    ``,
    `Category: ${task.category}`,
    `Description: ${task.description}`,
    `Payment: ${task.maxPrice} credits (you earn ${Math.floor(task.maxPrice * 0.95)})`,
    ``,
    `Input:`,
    JSON.stringify(task.input, null, 2),
    ``,
    `Complete this task. Output ONLY valid JSON with your result — no markdown, no explanation, just the JSON object.`,
  ].join('\n');
}

export async function execAgent(command: string, prompt: string, useCrust = false): Promise<Record<string, unknown>> {
  const fullCommand = useCrust ? `crust wrap -- ${command}` : command;
  const parts = fullCommand.split(/\s+/);
  const bin = parts[0];
  const args = [...parts.slice(1), prompt];

  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Agent command failed: ${error.message}${stderr ? `\nstderr: ${stderr}` : ''}`));
        return;
      }

      const output = stdout.trim();

      let jsonStr = output;
      const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      try {
        const parsed = JSON.parse(jsonStr);
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : { result: parsed });
      } catch {
        resolve({ result: output });
      }
    });
  });
}
