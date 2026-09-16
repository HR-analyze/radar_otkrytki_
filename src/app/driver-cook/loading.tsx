import { FiltersSkeleton, HeadingSkeleton, TilesSkeleton, TableSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Сверка отметок загружается">
      <HeadingSkeleton />
      {/* Критерий и статус на сверке не нужны — три поля, не пять. */}
      <FiltersSkeleton fields={3} />
      <TilesSkeleton count={4} />
      <TableSkeleton rows={8} cols={4} />
    </div>
  );
}
