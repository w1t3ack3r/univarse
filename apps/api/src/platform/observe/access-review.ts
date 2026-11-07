// Spec 0031 Q15: the monthly access review. The reviewer sees every member's access, marks each keep or needs a change,
// and attests. What was attested is stored as it stood, and can't be changed. The review changes nothing itself:
// "needs a change" is a note to act on the Staff page. A solo owner reviews their own access, and it's recorded as that.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformOps } from '@univarse/contracts';
import type { PlatformClient } from '@univarse/db';
import { canonicalReviewedAccess, reviewDecisionGaps, reviewPeriod, reviewStatus } from '@univarse/domain';
import type { z } from 'zod';
import { ProblemError } from '../../shared/errors/problem.js';
import { platformAudit } from '../identity/audit.js';
import { PlatformStaff } from '../identity/staff.service.js';
import type { PlatformActor, RequestMeta } from '../identity/types.js';
import { CONSOLE_DB } from '../platform-config.js';

type Attest = z.infer<typeof PlatformOps.attestAccessReview.body>;
type Current = z.infer<typeof PlatformOps.accessReview.response>;

type SnapshotMember = {
  id: string;
  role: string;
  isActive: boolean;
  mfaEnrolled: boolean;
  lastLoginAt: string | null;
  decision: 'keep' | 'change';
  note: string | null;
};

const hashOf = (members: Parameters<typeof canonicalReviewedAccess>[0]) => createHash('sha256').update(canonicalReviewedAccess(members)).digest();

@Injectable()
export class PlatformAccessReviews {
  constructor(
    @Inject(CONSOLE_DB) private readonly db: PlatformClient,
    private readonly staff: PlatformStaff,
  ) {}

  async current(now = new Date()): Promise<Current> {
    const [members, reviews] = await Promise.all([this.staff.list(), this.db.platformAccessReview.findMany({ orderBy: { period: 'desc' }, take: 24 })]);
    const reviewers = await this.db.platformUser.findMany({ where: { id: { in: [...new Set(reviews.map((r) => r.reviewerId))] } }, select: { id: true, displayName: true } });
    const names = new Map(reviewers.map((u) => [u.id, u.displayName]));
    return {
      period: reviewPeriod(now),
      status: reviewStatus(now, reviews[0]?.period ?? null),
      members: members.map(({ id, displayName, role, isActive, mfaEnrolled, lastLoginAt }) => ({ id, displayName, role, isActive, mfaEnrolled, lastLoginAt })),
      snapshotHash: hashOf(members).toString('hex'),
      history: reviews.map((r) => {
        const held = r.snapshot as unknown as readonly SnapshotMember[];
        return {
          id: r.id,
          period: r.period,
          reviewer: { id: r.reviewerId, name: names.get(r.reviewerId) ?? null },
          attestedAt: r.attestedAt.toISOString(),
          members: held.length,
          changesNeeded: held.filter((m) => m.decision === 'change').length,
        };
      }),
    };
  }

  async attest(actor: PlatformActor, input: Attest, meta: RequestMeta, now = new Date()): Promise<{ period: string; attestedAt: string }> {
    const period = reviewPeriod(now);
    const members = await this.staff.list();
    const hash = hashOf(members);
    if (hash.toString('hex') !== input.snapshotHash) throw new ProblemError(409, 'access_review.changed', "Someone's access changed since this page loaded");
    const gaps = reviewDecisionGaps(members.map((m) => m.id), input.decisions.map((d) => d.memberId));
    if (gaps.missing.length > 0 || gaps.unknown.length > 0) throw new ProblemError(422, 'access_review.incomplete', 'Every member needs a decision');
    const decisions = new Map(input.decisions.map((d) => [d.memberId, d]));
    const snapshot: SnapshotMember[] = members.map((m) => ({
      id: m.id,
      role: m.role,
      isActive: m.isActive,
      mfaEnrolled: m.mfaEnrolled,
      lastLoginAt: m.lastLoginAt,
      decision: decisions.get(m.id)?.decision ?? 'keep',
      note: decisions.get(m.id)?.note ?? null,
    }));
    try {
      return await this.db.$transaction(async (tx) => {
        const review = await tx.platformAccessReview.create({ data: { period, reviewerId: actor.userId, snapshot: snapshot, snapshotHash: hash } });
        // The notes stay in the review: free text never goes into the chain's metadata.
        await platformAudit(tx, { actorId: actor.userId, action: 'platform.access_review.attested', metadata: { reviewId: review.id, period, members: snapshot.length, changesNeeded: snapshot.filter((m) => m.decision === 'change').length } }, meta);
        return { period, attestedAt: review.attestedAt.toISOString() };
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ProblemError(409, 'access_review.already_done', "This month's review has already been attested");
      throw err;
    }
  }
}
