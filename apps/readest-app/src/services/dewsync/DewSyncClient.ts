import { DewSyncSettings } from '@/types/settings';

interface DewResult<T = unknown> {
  success: boolean;
  data?: T;
  isNetworkError?: boolean;
  message?: string;
}

interface UploadResponse {
  success: boolean;
  id: string;
  message?: string;
  duplicate?: boolean;
}

interface DocumentResponse {
  id: string;
  title?: string;
  author?: string;
  [key: string]: unknown;
}

export interface DewDocument {
  id: string;
  title: string;
  author: string;
  mime_type?: string;
  file_hash?: string;
  total_pages?: number;
  current_page?: number;
  reading_status?: string;
  source_connector?: string;
  created_at: string;
  updated_at: string;
}

export interface DewDocumentListResponse {
  documents: DewDocument[];
  total: number;
}

export interface DewNote {
  id: string;
  document_id: string;
  content: string;
  page_number?: number;
  metadata?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DewNotesResponse {
  notes: DewNote[];
}

interface UploadOptions {
  title: string;
  author: string;
  totalPages?: number;
  filename: string;
  sourceConnector: string;
}

interface ProgressInput {
  documentId: string;
  currentPage: number;
  status?: string;
}

interface NoteInput {
  documentId: string;
  content: string;
  pageNumber?: number;
  metadata?: string;
}

interface NoteUpdateInput {
  content?: string;
  metadata?: string;
}

export class DewSyncClient {
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

  async uploadDocument(file: Blob, options: UploadOptions): Promise<DewResult<UploadResponse>> {
    try {
      const formData = new FormData();
      formData.append('file', file, options.filename);
      formData.append('title', options.title);
      formData.append('author', options.author);
      formData.append('sourceConnector', options.sourceConnector);
      if (options.totalPages != null) {
        formData.append('totalPages', String(options.totalPages));
      }

      const res = await fetch(`${this.baseUrl}/documents/upload`, {
        method: 'POST',
        headers: this.headers,
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { success: false, message: `HTTP ${res.status}: ${errText}` };
      }

      const json = await res.json();
      // cc-mem wraps responses as { ok, data: { success, id, ... } }
      const payload = json.data ?? json;
      const docId = payload.id || payload.documentId;
      if (docId) {
        return { success: true, data: { ...payload, id: docId } };
      }
      return { success: false, message: `No document ID in response: ${JSON.stringify(json)}` };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async searchDocument(query: string): Promise<DewResult<{ id: string } | null>> {
    try {
      const res = await fetch(`${this.baseUrl}/documents/search`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}` };
      }
      const json = await res.json();
      const data = json.data ?? json;
      if (data.count > 0 && data.formatted) {
        // Parse first document ID from formatted response: ... (ID: uuid)
        const match = data.formatted.match(/\(ID:\s*([0-9a-f-]+)\)/);
        if (match) {
          return { success: true, data: { id: match[1] } };
        }
      }
      return { success: true, data: null };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async getDocument(id: string): Promise<DewResult<DocumentResponse>> {
    try {
      const res = await fetch(`${this.baseUrl}/documents/${id}`, { headers: this.headers });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as DocumentResponse;
      return { success: true, data };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async listDocuments(since?: string): Promise<DewResult<DewDocumentListResponse>> {
    try {
      const params = new URLSearchParams();
      if (since) params.set('since', since);
      const qs = params.toString();
      const url = `${this.baseUrl}/documents${qs ? `?${qs}` : ''}`;

      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}` };
      }
      const json = await res.json();
      const data = json.data ?? json;
      return { success: true, data };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async downloadFile(documentId: string): Promise<DewResult<Blob>> {
    try {
      const res = await fetch(`${this.baseUrl}/documents/${documentId}/file`, {
        headers: this.headers,
      });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}` };
      }
      const blob = await res.blob();
      return { success: true, data: blob };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async updateProgress(input: ProgressInput): Promise<DewResult> {
    try {
      const res = await fetch(`${this.baseUrl}/documents/progress`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { success: false, message: `HTTP ${res.status}: ${errText}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async addNote(input: NoteInput): Promise<DewResult<{ id: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/documents/notes`, {
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

  async getDocumentNotes(
    documentId: string,
    since?: string,
  ): Promise<DewResult<DewNotesResponse>> {
    try {
      const params = new URLSearchParams();
      if (since) params.set('since', since);
      const qs = params.toString();
      const url = `${this.baseUrl}/documents/${documentId}/notes${qs ? `?${qs}` : ''}`;

      const res = await fetch(url, {
        headers: this.headers,
      });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}` };
      }
      const json = await res.json();
      const data = json.data ?? json;
      return { success: true, data };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }

  async updateNote(noteId: string, input: NoteUpdateInput): Promise<DewResult> {
    try {
      const res = await fetch(`${this.baseUrl}/documents/notes/${noteId}`, {
        method: 'PUT',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { success: false, message: `HTTP ${res.status}: ${errText}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, message: (e as Error).message, isNetworkError: true };
    }
  }
}
