import { Book, BookNote } from '@/types/book';

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
