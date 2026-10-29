import { Notice } from '@univarse/ui';

/**
 * Spec 0027 P6: the console's only page until S2. It says plainly what exists and what doesn't: no navigation, no
 * sections, no mock data. S2 replaces it with the sign-in.
 */
export default function ConsoleHome() {
  return (
    <section className="pc-intro" aria-labelledby="pc-title">
      <h1 id="pc-title" className="pc-intro__title">
        Platform console
      </h1>
      <p className="pc-intro__lead">Where UniVarse staff will provision institutions, manage their products and keep the platform running.</p>
      <Notice tone="info">
        <strong>Sign-in isn&rsquo;t available yet.</strong> It arrives with the next release. Until then, nothing here can be viewed or
        changed.
      </Notice>
    </section>
  );
}
