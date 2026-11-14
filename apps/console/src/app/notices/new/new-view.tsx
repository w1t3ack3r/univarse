'use client';

import { ArrowLeft } from '@univarse/ui';
import Link from 'next/link';
import { useMe } from '../../../components/console-shell';
import { NothingHere } from '../../../components/nothing-here';
import { NoticeEditor } from '../notice-editor';

/** Spec 0037 Q9: a new notice. Nothing is stored until it's saved or published. */
export function NewNoticeView() {
  const me = useMe();
  if (!me.permissions.includes('platform.notice.publish')) return <NothingHere />;
  return (
    <section className="pc-section" aria-labelledby="new-notice-title">
      <Link className="uv-link pc-back" href="/notices">
        <ArrowLeft size={18} />
        Notices
      </Link>
      <h1 id="new-notice-title" className="pc-section__title">
        Write a notice
      </h1>
      <p className="pc-section__lead">Plain words, one next step. It reaches institutions as you see it in the preview.</p>
      <NoticeEditor notice={null} />
    </section>
  );
}
