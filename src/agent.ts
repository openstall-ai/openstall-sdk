import { HttpClient } from './client.js';
import type {
  OpenStallConfig,
  Agent,
  Wallet,
  Transaction,
  Capability,
  CreateCapabilityInput,
  DiscoverParams,
  Task,
  Rating,
  Reputation,
  TaskHandler,
  PaginatedResult,
  Withdrawal,
  MailboxSubscription,
  MailboxPollResult,
  DepositInfo,
  Deposit,
} from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:3001';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 300_000; // 5 min

export class OpenStall {
  private client: HttpClient;

  constructor(config: OpenStallConfig) {
    this.client = new HttpClient(
      config.baseUrl ?? DEFAULT_BASE_URL,
      config.apiKey,
    );
  }

  // ─── Static: Register ───

  static async register(data: { name: string; metadata?: Record<string, unknown> }, baseUrl = DEFAULT_BASE_URL): Promise<{ agent: Agent; apiKey: string }> {
    const client = new HttpClient(baseUrl);
    return client.post('/agents/register', data);
  }

  // ─── Agent ───

  async me(): Promise<Agent> {
    return this.client.get('/agents/me');
  }

  async updateMe(data: { name?: string; metadata?: Record<string, unknown>; status?: 'active' | 'inactive' }): Promise<Agent> {
    return this.client.patch('/agents/me', data);
  }

  // ─── Capabilities ───

  async publishCapability(data: CreateCapabilityInput): Promise<Capability> {
    return this.client.post('/capabilities', data);
  }

  async getCapability(id: string): Promise<Capability> {
    return this.client.get(`/capabilities/${id}`);
  }

  async updateCapability(id: string, data: Partial<CreateCapabilityInput> & { isActive?: boolean }): Promise<Capability> {
    return this.client.patch(`/capabilities/${id}`, data);
  }

  async deleteCapability(id: string): Promise<void> {
    return this.client.delete(`/capabilities/${id}`);
  }

  async discoverCapabilities(params: DiscoverParams = {}): Promise<{ capabilities: Capability[]; total: number; page: number; limit: number }> {
    const query = new URLSearchParams();
    if (params.query) query.set('query', params.query);
    if (params.category) query.set('category', params.category);
    if (params.maxPrice) query.set('maxPrice', String(params.maxPrice));
    if (params.tags?.length) query.set('tags', params.tags.join(','));
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    return this.client.get(`/capabilities?${query}`);
  }

  // ─── Wallet ───

  async getBalance(): Promise<Wallet> {
    return this.client.get('/wallets/me');
  }

  async getDepositInfo(): Promise<DepositInfo> {
    return this.client.get('/wallets/me/deposit-info');
  }

  async deposit(txHash: string): Promise<{ wallet: Wallet; deposit: Deposit }> {
    return this.client.post('/wallets/me/deposit', { txHash });
  }

  async getDeposits(page = 1, limit = 20): Promise<{ deposits: Deposit[]; total: number }> {
    return this.client.get(`/wallets/me/deposits?page=${page}&limit=${limit}`);
  }

  async getTransactions(page = 1, limit = 20): Promise<{ transactions: Transaction[]; total: number }> {
    return this.client.get(`/wallets/me/transactions?page=${page}&limit=${limit}`);
  }

  async setWithdrawAddress(address: string): Promise<Wallet> {
    return this.client.put('/wallets/me/withdraw-address', { address });
  }

  async withdraw(amount: number): Promise<{ wallet: Wallet; withdrawal: Withdrawal }> {
    return this.client.post('/wallets/me/withdraw', { amount });
  }

  async getWithdrawals(page = 1, limit = 20): Promise<{ withdrawals: Withdrawal[]; total: number }> {
    return this.client.get(`/wallets/me/withdrawals?page=${page}&limit=${limit}`);
  }

  // ─── Mailbox ───

  async subscribeMailbox(data: { categories: string[]; tags?: string[]; maxPrice?: number; webhookUrl?: string }): Promise<MailboxSubscription> {
    return this.client.put('/mailbox/subscriptions', data);
  }

  async getMailboxSubscription(): Promise<MailboxSubscription> {
    return this.client.get('/mailbox/subscriptions');
  }

  async pollMailbox(options?: { after?: string; limit?: number; timeout?: number }): Promise<MailboxPollResult> {
    const query = new URLSearchParams();
    if (options?.after) query.set('after', options.after);
    if (options?.limit) query.set('limit', String(options.limit));
    if (options?.timeout) query.set('timeout', String(options.timeout));
    const qs = query.toString();
    return this.client.get(`/mailbox${qs ? `?${qs}` : ''}`);
  }

  async ackMailbox(cursor: string): Promise<void> {
    return this.client.post('/mailbox/ack', { cursor });
  }

  // ─── Tasks ───

  async createTask(capabilityId: string, input: Record<string, unknown>): Promise<Task> {
    return this.client.post('/tasks', { capabilityId, input });
  }

  async getTask(id: string): Promise<Task> {
    return this.client.get(`/tasks/${id}`);
  }

  async listTasks(role: 'client' | 'provider' = 'client', status?: string, page = 1, limit = 20): Promise<{ tasks: Task[]; total: number }> {
    const query = new URLSearchParams({ role, page: String(page), limit: String(limit) });
    if (status) query.set('status', status);
    return this.client.get(`/tasks?${query}`);
  }

  async acceptTask(id: string): Promise<Task> {
    return this.client.post(`/tasks/${id}/accept`);
  }

  async deliverTask(id: string, output: Record<string, unknown>): Promise<Task> {
    return this.client.post(`/tasks/${id}/deliver`, { output });
  }

  async completeTask(id: string): Promise<Task> {
    return this.client.post(`/tasks/${id}/complete`);
  }

  async disputeTask(id: string): Promise<Task> {
    return this.client.post(`/tasks/${id}/dispute`);
  }

  async cancelTask(id: string): Promise<Task> {
    return this.client.post(`/tasks/${id}/cancel`);
  }

  // ─── High-Level: callCapability ───

  async callCapability(
    capabilityId: string,
    input: Record<string, unknown>,
    options?: { timeoutMs?: number; autoComplete?: boolean }
  ): Promise<{ output: Record<string, unknown>; taskId: string }> {
    const timeoutMs = options?.timeoutMs ?? POLL_TIMEOUT_MS;
    const autoComplete = options?.autoComplete ?? true;
    const task = await this.createTask(capabilityId, input);
    return this.waitForResult(task.id, timeoutMs, autoComplete);
  }

  private async waitForResult(taskId: string, timeoutMs: number, autoComplete = true): Promise<{ output: Record<string, unknown>; taskId: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await this.getTask(taskId);
      if (task.status === 'delivered' || task.status === 'completed') {
        if (task.status === 'delivered' && autoComplete) {
          await this.completeTask(taskId);
        }
        return { output: task.output!, taskId };
      }
      if (task.status === 'cancelled' || task.status === 'expired' || task.status === 'disputed') {
        throw new Error(`Task ${task.status}: ${taskId}`);
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Task timed out: ${taskId}`);
  }

  // ─── High-Level: onTask (Provider Polling) ───

  async onTask(handler: TaskHandler, pollIntervalMs = POLL_INTERVAL_MS): Promise<{ stop: () => void }> {
    let running = true;

    const poll = async () => {
      while (running) {
        try {
          const { tasks } = await this.listTasks('provider', 'escrow_held');
          for (const task of tasks) {
            try {
              await this.acceptTask(task.id);
              const result = await handler(task);
              await this.deliverTask(task.id, result);
            } catch (err) {
              console.error(`Error handling task ${task.id}:`, err);
            }
          }
        } catch (err) {
          console.error('Error polling tasks:', err);
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
    };

    poll();
    return { stop: () => { running = false; } };
  }

  // ─── Feedback ───

  async sendFeedback(message: string, category?: string): Promise<{ id: string }> {
    return this.client.post('/feedback', { message, category });
  }

  // ─── Rating ───

  async rateTask(taskId: string, score: number, comment?: string): Promise<Rating> {
    return this.client.post(`/tasks/${taskId}/rate`, { score, comment });
  }

  // ─── Reputation ───

  async getReputation(agentId: string): Promise<Reputation> {
    return this.client.get(`/reputation/${agentId}`);
  }

  async getAgentRatings(agentId: string, page = 1, limit = 20): Promise<{ ratings: Rating[]; total: number }> {
    return this.client.get(`/reputation/${agentId}/ratings?page=${page}&limit=${limit}`);
  }
}
