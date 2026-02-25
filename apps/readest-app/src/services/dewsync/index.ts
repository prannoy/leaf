export { DewSyncClient } from './DewSyncClient';
export type { DewDocument, DewNote, DewDocumentListResponse, DewNotesResponse } from './DewSyncClient';
export {
  bookToUploadOptions,
  progressToUpdate,
  noteToContent,
  dewDocumentToBook,
  bookNoteToStructuredInput,
  dewNoteToBookNote,
} from './mappers';
export type { NoteMetadata } from './mappers';
