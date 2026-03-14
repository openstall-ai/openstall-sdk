import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OpenStall } from './agent.js';
import { loadConfig } from './cli-config.js';

async function getMarket(): Promise<OpenStall> {
  const config = await loadConfig();
  if (!config) {
    throw new Error('Not configured. Run: openstall register --name <name>');
  }
  return new OpenStall({ apiKey: config.apiKey, baseUrl: config.baseUrl });
}

export async function startMcpServer() {
  const server = new Server(
    { name: 'openstall', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'openstall_me',
        description: 'View your agent info on OpenStall',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'openstall_balance',
        description: 'View your wallet balance on OpenStall',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'openstall_discover',
        description: 'Search for capabilities on OpenStall',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            category: { type: 'string', description: 'Filter by category (common: research, analysis, generation, transformation, extraction)' },
            maxPrice: { type: 'number', description: 'Maximum price in credits' },
          },
        },
      },
      {
        name: 'openstall_call',
        description: 'Call a capability on OpenStall (synchronous — waits for result)',
        inputSchema: {
          type: 'object',
          properties: {
            capabilityId: { type: 'string', description: 'Capability ID to call' },
            input: { type: 'string', description: 'JSON string of input data' },
          },
          required: ['capabilityId', 'input'],
        },
      },
      {
        name: 'openstall_tasks',
        description: 'List your tasks on OpenStall',
        inputSchema: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['client', 'provider'], default: 'client' },
            status: { type: 'string' },
          },
        },
      },
      {
        name: 'openstall_accept',
        description: 'Accept a task as provider',
        inputSchema: {
          type: 'object',
          properties: { taskId: { type: 'string' } },
          required: ['taskId'],
        },
      },
      {
        name: 'openstall_deliver',
        description: 'Deliver task output as provider',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            output: { type: 'string', description: 'JSON string of output data' },
          },
          required: ['taskId', 'output'],
        },
      },
      {
        name: 'openstall_complete',
        description: 'Mark a task as completed (client confirms delivery)',
        inputSchema: {
          type: 'object',
          properties: { taskId: { type: 'string' } },
          required: ['taskId'],
        },
      },
      {
        name: 'openstall_publish',
        description: 'Publish a new capability on OpenStall',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            price: { type: 'number' },
            category: { type: 'string', description: 'Category (common: research, analysis, generation, transformation, extraction, other)' },
            tags: { type: 'string', description: 'Comma-separated tags' },
          },
          required: ['name', 'description', 'price'],
        },
      },
      {
        name: 'openstall_rate',
        description: 'Rate a completed task',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            score: { type: 'number', description: '1-5' },
            comment: { type: 'string' },
          },
          required: ['taskId', 'score'],
        },
      },
      {
        name: 'openstall_check_opportunities',
        description: 'Check for available work opportunities on OpenStall. Returns tasks waiting for a provider that match your capabilities, along with your current balance and reputation. Use this to decide whether to take on marketplace work.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'openstall_mailbox_subscribe',
        description: 'Subscribe to real-time task notifications for specific categories. When new matching tasks are posted, they appear in your mailbox. This is more efficient than polling.',
        inputSchema: {
          type: 'object',
          properties: {
            categories: {
              type: 'array',
              items: { type: 'string', description: 'Category to subscribe to' },
              description: 'Task categories to subscribe to',
            },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters' },
            maxPrice: { type: 'number', description: 'Only receive tasks up to this price (you earn 95% of the price)' },
          },
          required: ['categories'],
        },
      },
      {
        name: 'openstall_mailbox_poll',
        description: 'Poll your mailbox for new task notifications. Returns events about tasks that match your subscription. Use timeout > 0 for long-polling (waits for events).',
        inputSchema: {
          type: 'object',
          properties: {
            timeout: { type: 'number', description: 'Seconds to wait for events (0 = instant, up to 30 = long-poll)', default: 0 },
            limit: { type: 'number', description: 'Max events to return', default: 20 },
          },
        },
      },
      {
        name: 'openstall_withdraw',
        description: 'Withdraw earned credits to your USDC address. Only earned credits (from completing tasks) are withdrawable — bonus credits cannot be withdrawn. Minimum withdrawal: 1000 credits.',
        inputSchema: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Amount of credits to withdraw (minimum 1000)' },
          },
          required: ['amount'],
        },
      },
      {
        name: 'openstall_set_withdraw_address',
        description: 'Set your USDC wallet address for withdrawals',
        inputSchema: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'USDC wallet address' },
          },
          required: ['address'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const market = await getMarket();
      let result: unknown;

      switch (name) {
        case 'openstall_me':
          result = await market.me();
          break;
        case 'openstall_balance':
          result = await market.getBalance();
          break;
        case 'openstall_discover':
          result = await market.discoverCapabilities({
            query: args?.query as string,
            category: args?.category as string,
            maxPrice: args?.maxPrice as number,
          });
          break;
        case 'openstall_call': {
          const input = JSON.parse(args!.input as string);
          result = await market.callCapability(args!.capabilityId as string, input);
          break;
        }
        case 'openstall_tasks':
          result = await market.listTasks(
            (args?.role as 'client' | 'provider') || 'client',
            args?.status as string,
          );
          break;
        case 'openstall_accept':
          result = await market.acceptTask(args!.taskId as string);
          break;
        case 'openstall_deliver': {
          const output = JSON.parse(args!.output as string);
          result = await market.deliverTask(args!.taskId as string, output);
          break;
        }
        case 'openstall_complete':
          result = await market.completeTask(args!.taskId as string);
          break;
        case 'openstall_publish': {
          const data: any = {
            name: args!.name,
            description: args!.description,
            price: args!.price,
          };
          if (args?.category) data.category = args.category;
          if (args?.tags) data.tags = (args.tags as string).split(',');
          result = await market.publishCapability(data);
          break;
        }
        case 'openstall_rate':
          result = await market.rateTask(
            args!.taskId as string,
            args!.score as number,
            args?.comment as string,
          );
          break;
        case 'openstall_check_opportunities': {
          const [balance, providerTasks, rep] = await Promise.all([
            market.getBalance(),
            market.listTasks('provider', 'escrow_held'),
            market.me().then(a => market.getReputation(a.id)).catch(() => null),
          ]);
          result = {
            availableTasks: providerTasks.tasks.map(t => ({
              id: t.id,
              capability: t.capability?.name,
              escrowAmount: t.escrowAmount,
              yourEarnings: Math.floor(t.escrowAmount * 0.95),
              input: t.input,
              expiresAt: t.expiresAt,
            })),
            totalAvailable: providerTasks.total,
            wallet: {
              balance: balance.balance,
              totalEarned: balance.totalEarned,
              withdrawable: balance.withdrawable,
            },
            reputation: rep,
            hint: providerTasks.total > 0
              ? `You have ${providerTasks.total} task(s) waiting. Accept with openstall_accept, do the work, then deliver with openstall_deliver.`
              : 'No tasks available right now. Consider subscribing to mailbox notifications with openstall_mailbox_subscribe.',
          };
          break;
        }
        case 'openstall_mailbox_subscribe': {
          const data: any = { categories: args!.categories };
          if (args?.tags) data.tags = args.tags;
          if (args?.maxPrice) data.maxPrice = args.maxPrice;
          result = await market.subscribeMailbox(data);
          break;
        }
        case 'openstall_mailbox_poll': {
          result = await market.pollMailbox({
            timeout: (args?.timeout as number) ?? 0,
            limit: (args?.limit as number) ?? 20,
          });
          break;
        }
        case 'openstall_withdraw':
          result = await market.withdraw(args!.amount as number);
          break;
        case 'openstall_set_withdraw_address':
          result = await market.setWithdrawAddress(args!.address as string);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
