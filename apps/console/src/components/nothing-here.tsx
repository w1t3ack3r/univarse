import { buttonClass } from '@univarse/ui';

/** An unknown address, and a page out of the member's scope: the same words for both (docs/08, out of scope → 404). */
export function NothingHere() {
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
