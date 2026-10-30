import { FiltersSkeleton, HeadingSkeleton, TableSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="КПИ загружается">
      <HeadingSkeleton />
      {/* У КПИ нет критерия и статуса, зато есть «Руководитель» — четыре поля. */}
      <FiltersSkeleton fields={4} />
      <TableSkeleton rows={12} />
    </div>
  );
}
