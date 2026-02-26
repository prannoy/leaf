import { Book, BookNote } from '@/types/book';
import { MemoryInput } from './DewSyncClient';

export function highlightToMemory(note: BookNote, bookTitle: string): MemoryInput {
  return {
    content: `[Highlight from "${bookTitle}"] ${note.text || ''}`,
    tags: ['book-highlight', 'leaf'],
    sourceConnector: 'leaf',
  };
}

export function annotationToMemory(note: BookNote, bookTitle: string): MemoryInput {
  const parts: string[] = [];
  parts.push(`[Note on "${bookTitle}"] ${note.note || ''}`);
  if (note.text) {
    parts.push(`> ${note.text}`);
  }
  return {
    content: parts.join('\n'),
    tags: ['book-note', 'leaf'],
    sourceConnector: 'leaf',
  };
}

export function bookCompletionToMemory(book: Book): MemoryInput {
  const pages = book.progress?.[1];
  const pagesStr = pages ? ` (${pages} pages)` : '';
  return {
    content: `Finished reading "${book.title}" by ${book.author || 'Unknown'}${pagesStr}`,
    tags: ['book-completed', 'leaf'],
    sourceConnector: 'leaf',
  };
}
