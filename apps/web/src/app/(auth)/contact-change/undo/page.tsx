import type { Metadata } from 'next';
import { UndoForm } from './UndoForm';

export const metadata: Metadata = { title: 'Undo an address change' };

export default function UndoContactChangePage() {
  return <UndoForm />;
}
