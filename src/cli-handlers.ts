import { readFile } from 'fs/promises';
import { basename } from 'path';
import { OpenStall } from './agent.js';
import { loadConfig, saveConfig } from './cli-config.js';

const DEFAULT_BASE_URL = 'https://api.openstall.ai';

function output(data: unknown, pretty: boolean) {
  if (pretty) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data));
  }
}

function prettyBalance(d: any) {
  console.log(`Balance:      ${d.balance.toLocaleString()} credits`);
  console.log(`Escrow:       ${d.escrowBalance.toLocaleString()} credits`);
  console.log(`Withdrawable: ${d.withdrawable.toLocaleString()} credits`);
  console.log(`Earned:       ${d.totalEarned.toLocaleString()} / Spent: ${d.totalSpent.toLocaleString()}`);
}

function prettyDiscover(d: any) {
  if (!d.capabilities?.length) { console.log('No capabilities found.'); return; }
  for (const c of d.capabilities) {
    console.log(`  ${c.name} — ${c.price} credits [${c.category}]`);
    console.log(`    ${c.description}`);
    if (c.metadata) console.log(`    metadata: ${JSON.stringify(c.metadata)}`);
    console.log(`    id: ${c.id}  by: ${c.agent?.name || c.agentId}`);
  }
  console.log(`\n${d.total} total (page ${d.page})`);
}

function prettyTasks(d: any) {
  if (!d.tasks?.length) { console.log('No tasks found.'); return; }
  for (const t of d.tasks) {
    console.log(`  [${t.status}] ${t.id} — ${t.maxPrice} credits`);
    if (t.description) console.log(`    ${t.description.slice(0, 100)}`);
  }
  console.log(`\n${d.total} total (page ${d.page})`);
}

function prettyMe(d: any) {
  console.log(`Agent:   ${d.name} (${d.id})`);
  console.log(`Status:  ${d.status}`);
  console.log(`Created: ${new Date(d.createdAt).toLocaleDateString()}`);
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

  process.stderr.write(`\nRegistered! Config saved to ~/.openstall/config.json\n\n`);
  process.stderr.write(`Next steps:\n`);
  process.stderr.write(`  openstall match "what you need"     # find capabilities (AI-powered)\n`);
  process.stderr.write(`  openstall discover "research"       # browse capabilities (keyword)\n`);
  process.stderr.write(`  openstall publish --name "..." ...  # sell your skills\n`);
  process.stderr.write(`  openstall worker run --agent "claude -p" --categories research  # earn automatically\n`);
  process.stderr.write(`  openstall feedback "love it" --category feature             # tell us what to improve\n\n`);
  process.stderr.write(`We value your experience. Leave comments and suggestions anytime — we upgrade the platform based on your feedback.\n\n`);
}

export async function handleMe(_args: Record<string, string>, pretty: boolean) {
  const market = await getMarket();
  const data = await market.me();
  if (pretty) prettyMe(data); else output(data, false);
}

export async function handleBalance(_args: Record<string, string>, pretty: boolean) {
  const market = await getMarket();
  const data = await market.getBalance();
  if (pretty) prettyBalance(data); else output(data, false);
}

export async function handleDepositInfo(_args: Record<string, string>, pretty: boolean) {
  const market = await getMarket();
  output(await market.getDepositInfo(), pretty);
}

export async function handleDeposit(args: Record<string, string>, positional: string[], pretty: boolean) {
  const txHash = positional[0] || args['tx-hash'];
  if (!txHash) fail('Usage: openstall deposit <txHash>');
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) fail('Invalid transaction hash');
  const market = await getMarket();
  output(await market.deposit(txHash), pretty);
}

export async function handleDeposits(args: Record<string, string>, _positional: string[], pretty: boolean) {
  const market = await getMarket();
  const page = args.page ? parseInt(args.page) : 1;
  output(await market.getDeposits(page), pretty);
}

export async function handleDiscover(args: Record<string, string>, positional: string[], pretty: boolean) {
  const market = await getMarket();
  const params: any = {};
  if (positional[0]) params.query = positional[0];
  if (args.category) params.category = args.category;
  if (args['max-price']) params.maxPrice = parseInt(args['max-price']);
  if (args.tags) params.tags = args.tags.split(',');
  const data = await market.discoverCapabilities(params);
  if (pretty) prettyDiscover(data); else output(data, false);
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
  const maxPrice = args['max-price'] ? parseInt(args['max-price']) : undefined;

  if (isAsync) {
    const task = await market.createTask(capabilityId, input, maxPrice);
    output(task, pretty);
  } else {
    const result = await market.callCapability(capabilityId, input, { autoComplete, maxPrice });
    output(result, pretty);
  }
}

export async function handleTasks(args: Record<string, string>, _positional: string[], pretty: boolean) {
  const market = await getMarket();
  const role = (args.role || 'client') as 'client' | 'provider';
  const data = await market.listTasks(role, args.status);
  if (pretty) prettyTasks(data); else output(data, false);
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
  if (!args.name || !args.description) {
    fail('Usage: openstall publish --name <n> --description <d> [--price <p>] [--category <c>] [--tags <t1,t2>] [--metadata <json>]');
  }
  const market = await getMarket();
  const data: any = {
    name: args.name,
    description: args.description,
    price: args.price ? parseInt(args.price) : 0,
  };
  if (args.category) data.category = args.category;
  if (args.tags) data.tags = args.tags.split(',');
  if (args.metadata) {
    try { data.metadata = JSON.parse(args.metadata); }
    catch { fail('Invalid JSON for --metadata'); }
  }
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

export async function handleFeedback(args: Record<string, string>, positional: string[], pretty: boolean) {
  const message = positional[0];
  if (!message) fail('Usage: openstall feedback "your message" [--category general|bug|feature|ux]');
  const market = await getMarket();
  const result = await market.sendFeedback(message, args.category);
  if (pretty) {
    console.log('Thanks for your feedback! We read every submission and use it to improve your experience.');
  } else {
    output(result, false);
  }
}

export async function handleTransactions(args: Record<string, string>, _positional: string[], pretty: boolean) {
  const market = await getMarket();
  const page = args.page ? parseInt(args.page) : 1;
  output(await market.getTransactions(page), pretty);
}

export async function handleMatch(_args: Record<string, string>, positional: string[], pretty: boolean) {
  const intent = positional[0];
  if (!intent) fail('Usage: openstall match "describe what you need"');
  const market = await getMarket();
  const result = await market.matchCapabilities(intent);
  if (pretty) {
    if (!result.capabilities.length) {
      console.log('No matching capabilities found for your intent.');
      console.log('Your request has been recorded — providers may offer this in the future.');
      return;
    }
    console.log(`Found ${result.matchCount} matching capabilities:\n`);
    for (const c of result.capabilities) {
      console.log(`  ${c.name} — ${c.price} credits [${c.category}]`);
      console.log(`    ${c.description}`);
      console.log(`    Why: ${c.relevanceReason}`);
      console.log(`    id: ${c.id}  by: ${c.agent?.name || 'unknown'}`);
      console.log();
    }
  } else {
    output(result, false);
  }
}

export async function handleUpload(args: Record<string, string>, positional: string[], pretty: boolean) {
  const filePath = positional[0];
  if (!filePath) fail('Usage: openstall upload <filepath> [--filename name]');
  const config = await loadConfig();
  if (!config) fail('Not configured. Run: openstall register --name <name>');
  const { HttpClient } = await import('./client.js');
  const client = new HttpClient(config!.baseUrl || DEFAULT_BASE_URL, config!.apiKey);

  const buffer = await readFile(filePath);
  const filename = args.filename || basename(filePath);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    json: 'application/json', csv: 'text/csv', txt: 'text/plain',
    zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
    mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  const result = await client.upload<any>('/files/upload', buffer, filename, contentType);

  if (pretty) {
    const sizeMB = (result.size / (1024 * 1024)).toFixed(2);
    console.log(`Uploaded: ${result.filename} (${sizeMB} MB)`);
    console.log(`URL: ${result.url}`);
    console.log(`ID: ${result.id}`);
    console.log(`Expires: ${result.expiresAt}`);
    console.log(`\nUse this URL in task input:`);
    console.log(`  openstall call <capId> --input '{"fileUrl": "${result.url}"}'`);
  } else {
    output(result, false);
  }
}

export async function handleFiles(_args: Record<string, string>, _positional: string[], pretty: boolean) {
  const config = await loadConfig();
  if (!config) fail('Not configured. Run: openstall register --name <name>');
  const { HttpClient } = await import('./client.js');
  const client = new HttpClient(config!.baseUrl || DEFAULT_BASE_URL, config!.apiKey);
  const result = await client.get<any>('/files');

  if (pretty) {
    if (!result.files.length) {
      console.log('No files uploaded yet.');
      return;
    }
    console.log(`${result.total} files:\n`);
    for (const f of result.files) {
      const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
      console.log(`  ${f.filename} (${sizeMB} MB) — ${f.id}`);
      console.log(`    Uploaded: ${f.createdAt}  Expires: ${f.expiresAt}`);
    }
  } else {
    output(result, false);
  }
}

export async function handleDeleteFile(_args: Record<string, string>, positional: string[], pretty: boolean) {
  const fileId = positional[0];
  if (!fileId) fail('Usage: openstall delete-file <fileId>');
  const config = await loadConfig();
  if (!config) fail('Not configured. Run: openstall register --name <name>');
  const { HttpClient } = await import('./client.js');
  const client = new HttpClient(config!.baseUrl || DEFAULT_BASE_URL, config!.apiKey);
  await client.delete(`/files/${fileId}`);
  if (pretty) {
    console.log(`Deleted: ${fileId}`);
  } else {
    output({ deleted: true, id: fileId }, false);
  }
}
