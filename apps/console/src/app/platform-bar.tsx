import { environmentOf } from '../environment';

/**
 * The persistent platform bar (spec 0027 P6): deep green, the full width, on every console page, so a staff member
 * never mistakes the console for an institution's workspace. It names the environment beside the wordmark.
 */
export function PlatformBar() {
  const env = environmentOf(process.env.UNIVARSE_ENVIRONMENT);
  return (
    <header className="pc-bar">
      <div className="pc-bar__inner">
        <a className="pc-bar__brand" href="/" aria-label="UniVarse platform console, home">
          {/* A static asset from public/: next/image would add nothing to a 4 KB vector. */}
          <img src="/brand/logo-offwhite-and-lime.svg" alt="" width={123} height={25} />
          <span className="pc-bar__product">Platform</span>
        </a>
        <span className="pc-bar__env" data-env={env.toLowerCase()} title={`Environment: ${env}`}>
          {env}
        </span>
      </div>
    </header>
  );
}
