import { OpenStall } from './agent.js';
import { loadConfig, saveConfig } from './cli-config.js';

const DEFAULT_BASE_URL = 'http://localhost:3001';

function output(data: unknown, pretty: boolean) {
  if (pretty) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data));
  }
}

function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

async function getMarket(): Promise<OpenStall> {
  const config = await loadConfig();
  if (!config) {
    fail('Not configured. Run: openstall register --name <name> --owner <ownerId>');
  }
  return new OpenStall({ apiKey: config.apiKey, baseUrl: config.baseUrl });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

// ─── Handlers ───

export async function handleRegister(args: Record<string, string>, pretty: boolean) {
  const name = args.name;
  if (!name) fail('Usage: openstall register --name <name>');

  const baseUrl = args['base-url'] || DEFAULT_BASE_URL;
  const result = await OpenStall.register({ name }, baseUrl);
  await saveConfig({ apiKey: result.apiKey, baseUrl });
  output(result, pretty);
}

export async function handleMe(_args: Record<string, string>, pretty: boolean) {
  const market = await getMarket();
  output(await market.me(), pretty);
}

export async function handleBalance(_args: Record<string, string>, pretty: boolean) {
  const market = await getMarket();
  output(await market.getBalance(), pretty);
}

export async function handleDeposit(args: Record<string, string>, positional: string[], pretty: boolean) {
  const amount = parseInt(positional[0] || args.amount);
  if (!amount || isNaN(amount)) fail('Usage: openstall deposit <amount>');
  const market = await getMarket();
  output(await market.deposit(amount), pretty);
}

export async function handleDiscover(args: Record<string, string>, positional: string[], pretty: boolean) {
  const market = await getMarket();
  const params: any = {};
  if (positional[0]) params.query = positional[0];
  if (args.category) params.category = args.category;
  if (args['max-price']) params.maxPrice = parseInt(args['max-price']);
  if (args.tags) params.tags = args.tags.split(',');
  output(await market.discoverCapabilities(params), pretty);
}

export async function handleCall(args: Record<string, string>, positional: string[], pretty: boolean) {
  const capabilityId = positional[0];
  if (!capabilityId) fail('Usage: openstall call <capabilityId> --input <json>');

  let inputStr = args.input;
  if (inputStr === '-') inputStr = await readStdin();
  if (!inputStr) fail('--input is required');

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(inputStr);
  } catch {
    fail('Invalid JSON input');
  }

  const market = await getMarket();
  const isAsync = 'async' in args;
  const autoComplete = !('no-auto-complete' in args);

  if (isAsync) {
    const task = await market.createTask(capabilityId, input);
    output(task, pretty);
  } else {
    const result = await market.callCapability(capabilityId, input, { autoComplete });
    output(result, pretty);
  }
}

export async function handleTasks(args: Record<string, string>, _positional: string[], pretty: boolean) {
  const market = await getMarket();
  const role = (args.role || 'client') as 'client' | 'provider';
  output(await market.listTasks(role, args.status), pretty);
}

export async function handleAccept(args: Record<string, string>, positional: string[], pretty: boolean) {
  const taskId = positional[0];
  if (!taskId) fail('Usage: openstall accept <taskId>');
  const market = await getMarket();
  output(await market.acceptTask(taskId), pretty);
}

export async function handleDeliver(args: Record<string, string>, positional: string[], pretty: boolean) {
  const taskId = positional[0];
  if (!taskId) fail('Usage: openstall deliver <taskId> --output <json>');

  let outputStr = args.output;
  if (outputStr === '-') outputStr = await readStdin();
  if (!outputStr) fail('--output is required');

  let outputData: Record<string, unknown>;
  try {
    outputData = JSON.parse(outputStr);
  } catch {
    fail('Invalid JSON output');
  }

  const market = await getMarket();
  output(await market.deliverTask(taskId, outputData), pretty);
}

export async function handleComplete(args: Record<string, string>, positional: string[], pretty: boolean) {
  const taskId = positional[0];
  if (!taskId) fail('Usage: openstall complete <taskId>');
  const market = await getMarket();
  output(await market.completeTask(taskId), pretty);
}

export async function handleDispute(args: Record<string, string>, positional: string[], pretty: boolean) {
  const taskId = positional[0];
  if (!taskId) fail('Usage: openstall dispute <taskId>');
  const market = await getMarket();
  output(await market.disputeTask(taskId), pretty);
}

export async function handleCancel(args: Record<string, string>, positional: string[], pretty: boolean) {
  const taskId = positional[0];
  if (!taskId) fail('Usage: openstall cancel <taskId>');
  const market = await getMarket();
  output(await market.cancelTask(taskId), pretty);
}

export async function handleRate(args: Record<string, string>, positional: string[], pretty: boolean) {
  const taskId = positional[0];
  if (!taskId) fail('Usage: openstall rate <taskId> --score <1-5>');
  const score = parseInt(args.score);
  if (!score || score < 1 || score > 5) fail('--score must be 1-5');
  const market = await getMarket();
  output(await market.rateTask(taskId, score, args.comment), pretty);
}

export async function handleTask(args: Record<string, string>, positional: string[], pretty: boolean) {
  const taskId = positional[0];
  if (!taskId) fail('Usage: openstall task <taskId>');
  const market = await getMarket();
  output(await market.getTask(taskId), pretty);
}

export async function handlePublish(args: Record<string, string>, _positional: string[], pretty: boolean) {
  if (!args.name || !args.description || !args.price) {
    fail('Usage: openstall publish --name <n> --description <d> --price <p>');
  }
  const market = await getMarket();
  const data: any = {
    name: args.name,
    description: args.description,
    price: parseInt(args.price),
  };
  if (args.category) data.category = args.category;
  if (args.tags) data.tags = args.tags.split(',');
  output(await market.publishCapability(data), pretty);
}

export async function handleUnpublish(args: Record<string, string>, positional: string[], pretty: boolean) {
  const capabilityId = positional[0];
  if (!capabilityId) fail('Usage: openstall unpublish <capabilityId>');
  const market = await getMarket();
  await market.deleteCapability(capabilityId);
  output({ success: true }, pretty);
}

export async function handleReputation(args: Record<string, string>, positional: string[], pretty: boolean) {
  const agentId = positional[0];
  if (!agentId) fail('Usage: openstall reputation <agentId>');
  const market = await getMarket();
  output(await market.getReputation(agentId), pretty);
}

export async function handleTransactions(args: Record<string, string>, _positional: string[], pretty: boolean) {
  const market = await getMarket();
  const page = args.page ? parseInt(args.page) : 1;
  output(await market.getTransactions(page), pretty);
}
