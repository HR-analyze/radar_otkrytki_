import { HeadingSkeleton, TableSkeleton, TilesSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="График пиков загружается">
      <HeadingSkeleton />
      <TilesSkeleton count={4} />
      <TableSkeleton rows={12} cols={20} />
    </div>
  );
}
