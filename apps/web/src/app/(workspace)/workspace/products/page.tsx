import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { ConfirmToContinue, ProductSwitches, type ProductState } from './ProductSwitches';

export const metadata: Metadata = { title: 'Products' };

/**
 * Spec 0003 P4/P6 in the web app; spec 0005 W14. settings.product.manage is step-up flagged, so the
 * first load usually answers 428 and the page asks the person to confirm it's them.
 */
export default async function ProductsPage() {
  await requireSession();
  const res = await serverApi<{ data: ProductState[] }>('/api/v1/admin/products');
  if (res.status !== 200 && res.status !== 428) notFound();
  return (
    <div className="page">
      <h1 className="page__title">Products</h1>
      <p className="page__lede">Switch on the parts of UniVarse your institution uses. Your plan decides which ones you can switch on.</p>
      {res.status === 428 || !res.body ? <ConfirmToContinue /> : <ProductSwitches initial={res.body.data} />}
    </div>
  );
}
