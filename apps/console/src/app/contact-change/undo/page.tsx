import type { Metadata } from 'next';
import { UndoForm } from './undo-form';

export const metadata: Metadata = { title: 'Undo an address change' };

export default function UndoContactChangePage() {
  return <UndoForm />;
}
