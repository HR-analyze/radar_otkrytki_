import { FiltersSkeleton, HeadingSkeleton, TilesSkeleton, TableSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Нарушения загружаются">
      <HeadingSkeleton />
      {/* Критерий и статус здесь не нужны — три поля, не пять. */}
      <FiltersSkeleton fields={3} />
      <TilesSkeleton count={4} />
      <TableSkeleton rows={6} cols={5} />
      <TableSkeleton rows={6} cols={7} />
    </div>
  );
}
