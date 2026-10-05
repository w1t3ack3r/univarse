import { redirect } from 'next/navigation';

/** The tenant app has no public home yet: go to the workspace (which sends guests to login). */
export default function Root(): never {
  redirect('/workspace');
}
