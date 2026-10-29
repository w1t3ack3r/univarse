import type { Metadata } from 'next';
import { buttonClass } from '@univarse/ui';

export const metadata: Metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <section className="pc-intro" aria-labelledby="pc-title">
      <h1 id="pc-title" className="pc-intro__title">
        There&rsquo;s nothing at this address
      </h1>
      <p className="pc-intro__lead">Check the address, or go back to the console&rsquo;s start.</p>
      <a className={buttonClass('quiet')} href="/">
        Back to the console
      </a>
    </section>
  );
}
