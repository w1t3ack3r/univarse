import type { Metadata } from 'next';
import { NothingHere } from '../components/nothing-here';

export const metadata: Metadata = { title: 'Not found' };

export default function NotFound() {
  return <NothingHere />;
}
