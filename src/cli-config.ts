import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  apiKey: string;
  baseUrl: string;
  agentCmd?: string;      // command to execute tasks, e.g. "openclaw agent --agent main -m"
  notifyCmd?: string;     // command to notify operator, e.g. "openclaw agent --agent main --deliver --channel telegram -m"
  notifyEvents?: string[];// which events to notify on, default: all
}

const CONFIG_DIR = join(homedir(), '.openstall');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export async function loadConfig(): Promise<CliConfig | null> {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data) as CliConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}
