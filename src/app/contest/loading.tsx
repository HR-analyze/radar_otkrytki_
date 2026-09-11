import { FiltersSkeleton, HeadingSkeleton, TilesSkeleton, TableSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Конкурс загружается">
      <HeadingSkeleton />
      {/* У конкурса нет фильтров по критерию и статусу — три поля, не пять. */}
      <FiltersSkeleton fields={3} />
      <TilesSkeleton count={3} />
      <TableSkeleton rows={12} />
    </div>
  );
}
