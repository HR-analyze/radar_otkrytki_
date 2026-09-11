import { FiltersSkeleton, HeadingSkeleton, TableSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Радар загружается">
      <HeadingSkeleton />
      <FiltersSkeleton />
      <TableSkeleton rows={14} />
    </div>
  );
}
