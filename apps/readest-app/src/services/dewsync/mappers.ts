import { Book, BookFormat, BookNote, BookNoteType, ReadingStatus } from '@/types/book';
import { DewDocument, DewNote } from './DewSyncClient';

export function bookToUploadOptions(book: Book) {
  return {
    title: book.title,
    author: book.author,
    totalPages: book.progress?.[1],
    filename: book.sourceTitle || `${book.title}.${book.format.toLowerCase()}`,
    sourceConnector: 'leaf',
  };
}

export function progressToUpdate(documentId: string, book: Book) {
  if (!book.progress) return null;
  const [current] = book.progress;
  // Leaf progress is 1-based; cc-mem currentPage is 0-based
  const currentPage = Math.max(0, current - 1);

  let status: string | undefined;
  if (book.readingStatus === 'finished') {
    status = 'completed';
  } else if (book.readingStatus === 'reading') {
    status = 'reading';
  }

  return { documentId, currentPage, status };
}

export function noteToContent(note: BookNote): string {
  const parts: string[] = [];

  if (note.text) {
    parts.push(`> ${note.text}`);
  }
  if (note.note) {
    parts.push(`Note: ${note.note}`);
  }

  const meta: string[] = [];
  if (note.style) meta.push(`style:${note.style}`);
  if (note.color) meta.push(`color:${note.color}`);
  if (note.type) meta.push(`type:${note.type}`);
  if (meta.length > 0) {
    parts.push(`[${meta.join(', ')}]`);
  }

  return parts.join('\n');
}

// --- Reverse mappers (Dew → Leaf) ---

const MIME_TO_FORMAT: Record<string, BookFormat> = {
  'application/epub+zip': 'EPUB',
  'application/pdf': 'PDF',
  'application/x-mobipocket-ebook': 'MOBI',
  'application/octet-stream': 'EPUB', // default fallback
};

function dewStatusToReadingStatus(status?: string): ReadingStatus | undefined {
  if (!status) return undefined;
  if (status === 'completed') return 'finished';
  if (status === 'reading') return 'reading';
  return 'unread';
}

function guessFormatFromFilename(title: string): BookFormat {
  const lower = title.toLowerCase();
  if (lower.endsWith('.pdf')) return 'PDF';
  if (lower.endsWith('.mobi')) return 'MOBI';
  if (lower.endsWith('.azw') || lower.endsWith('.azw3')) return 'AZW3';
  if (lower.endsWith('.fb2') || lower.endsWith('.fbz')) return 'FB2';
  if (lower.endsWith('.cbz')) return 'CBZ';
  if (lower.endsWith('.txt')) return 'TXT';
  return 'EPUB';
}

export function dewDocumentToBook(doc: DewDocument): Partial<Book> {
  const format =
    (doc.mimeType && MIME_TO_FORMAT[doc.mimeType]) || guessFormatFromFilename(doc.title);

  const book: Partial<Book> = {
    title: doc.title,
    author: doc.author || '',
    format,
    readingStatus: dewStatusToReadingStatus(doc.readingStatus),
    createdAt: new Date(doc.createdAt).getTime(),
    updatedAt: new Date(doc.updatedAt).getTime(),
  };

  if (doc.currentPage != null && doc.totalPages != null) {
    // cc-mem is 0-based, Leaf is 1-based
    book.progress = [doc.currentPage + 1, doc.totalPages];
  }

  return book;
}

export interface NoteMetadata {
  cfi?: string;
  style?: string;
  color?: string;
  type?: string;
  text?: string;
  leafNoteId?: string;
  updatedAt?: number;
  deletedAt?: number | null;
}

/**
 * Build the input for addNote (POST) + updateNote (PUT) two-step flow.
 * POST /documents/notes creates the note (content only).
 * PUT /documents/notes/:id adds metadata (POST doesn't persist metadata).
 */
export function bookNoteToStructuredInput(
  note: BookNote,
  documentId: string,
): { documentId: string; content: string; metadata: NoteMetadata } {
  const metadata: NoteMetadata = {
    cfi: note.cfi,
    style: note.style,
    color: note.color,
    type: note.type,
    text: note.text,
    leafNoteId: note.id,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
  };

  const content = noteToContent(note);

  return {
    documentId,
    content,
    metadata,
  };
}

export function dewNoteToBookNote(dewNote: DewNote, bookHash: string): BookNote {
  // metadata is already a parsed object from the API (not a JSON string)
  const metadata = dewNote.metadata as NoteMetadata | null;

  if (metadata?.leafNoteId) {
    // Reconstructing from structured metadata — this note originated from Leaf
    return {
      bookHash,
      id: metadata.leafNoteId,
      type: (metadata.type as BookNoteType) || 'annotation',
      cfi: metadata.cfi || '',
      text: metadata.text,
      style: metadata.style as BookNote['style'],
      color: metadata.color as BookNote['color'],
      note: extractNoteText(dewNote.content),
      createdAt: new Date(dewNote.createdAt).getTime(),
      updatedAt: metadata.updatedAt || new Date(dewNote.updatedAt).getTime(),
      deletedAt: metadata.deletedAt,
    };
  }

  // External note (created outside Leaf) — add as annotation without CFI
  return {
    bookHash,
    id: `dew-${dewNote.id}`,
    type: 'annotation',
    cfi: '',
    text: dewNote.content,
    note: '',
    createdAt: new Date(dewNote.createdAt).getTime(),
    updatedAt: new Date(dewNote.updatedAt).getTime(),
  };
}

function extractNoteText(content: string): string {
  const match = content.match(/^Note:\s*(.+)$/m);
  return match?.[1] ?? '';
}
