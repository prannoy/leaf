import { DewSyncSettings } from '@/types/settings';

interface DewResult<T = unknown> {
  success: boolean;
  data?: T;
  isNetworkError?: boolean;
  message?: string;
}

export interface MemoryInput {
  content: string;
  tags: string[];
  sourceConnector: string;
}

interface MemoryResponse {
  id: string;
}

interface ContentUploadResponse {
  success: boolean;
  id?: string;
  message?: string;
  duplicate?: boolean;
}

interface ContentUploadOptions {
  filename: string;
  title?: string;
  author?: string;
}

export class DewMemoryClient {
  private config: DewSyncSettings;

  constructor(config: DewSyncSettings) {
    this.config = config;
  }

  private get baseUrl(): string {
    return `${this.config.apiUrl}/api/v1`;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async checkHealth(): Promise<DewResult> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers });
      return { success: res.ok };
    } catch {
      return { success: false, isNetworkError: true };
    }
  }

  async pushMemory(input: MemoryInput): Promise<DewResult<MemoryResponse>> {
    try {
      const res = await fetch(`${this.baseUrl}/memories`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { success: false, message: `HTTP ${res.status}: ${errText}` };
      }

      const json = await res.json();
      const payload = json.data ?? json;
      return { success: true, data: { id: payload.id || '' } };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async uploadContent(
    file: Blob,
    options: ContentUploadOptions,
  ): Promise<DewResult<ContentUploadResponse>> {
    try {
      const formData = new FormData();
      formData.append('file', file, options.filename);
      if (options.title) formData.append('title', options.title);
      if (options.author) formData.append('author', options.author);

      const res = await fetch(`${this.baseUrl}/content/upload`, {
        method: 'POST',
        headers: this.headers,
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { success: false, message: `HTTP ${res.status}: ${errText}` };
      }

      const json = await res.json();
      const payload = json.data ?? json;
      return { success: true, data: payload };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }
}
