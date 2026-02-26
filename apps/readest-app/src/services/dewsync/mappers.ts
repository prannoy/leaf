import { Book, BookNote } from '@/types/book';
import { MemoryInput } from './DewSyncClient';

export function highlightToMemory(
  note: BookNote,
  bookTitle: string,
  sourceId?: string,
): MemoryInput {
  return {
    content: `[Highlight from "${bookTitle}"] ${note.text || ''}`,
    tags: ['book-highlight', 'leaf'],
    sourceConnector: 'leaf',
    sourceId,
  };
}

export function annotationToMemory(
  note: BookNote,
  bookTitle: string,
  sourceId?: string,
): MemoryInput {
  const parts: string[] = [];
  parts.push(`[Note on "${bookTitle}"] ${note.note || ''}`);
  if (note.text) {
    parts.push(`> ${note.text}`);
  }
  return {
    content: parts.join('\n'),
    tags: ['book-note', 'leaf'],
    sourceConnector: 'leaf',
    sourceId,
  };
}

export function readingSessionToMemory(
  book: Book,
  pagesRead: number,
  sourceId?: string,
): MemoryInput {
  const [current, total] = book.progress ?? [0, 0];
  return {
    content: `Read ${pagesRead} pages of "${book.title}" by ${book.author || 'Unknown'} (now on page ${current}/${total})`,
    tags: ['reading-session', 'leaf'],
    sourceConnector: 'leaf',
    sourceId,
  };
}

export function bookCompletionToMemory(book: Book, sourceId?: string): MemoryInput {
  const pages = book.progress?.[1];
  const pagesStr = pages ? ` (${pages} pages)` : '';
  return {
    content: `Finished reading "${book.title}" by ${book.author || 'Unknown'}${pagesStr}`,
    tags: ['book-completed', 'leaf'],
    sourceConnector: 'leaf',
    sourceId,
  };
}
