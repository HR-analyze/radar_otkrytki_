import { FiltersSkeleton, HeadingSkeleton, TilesSkeleton, CardSkeleton } from '@/components/Skeleton';

/** Заглушка сводки: те же блоки в том же порядке, что на собранной странице. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Сводка загружается">
      <HeadingSkeleton />
      <FiltersSkeleton />
      <TilesSkeleton />
      <CardSkeleton rows={6} />
      <div className="grid gap-5 lg:grid-cols-2">
        <CardSkeleton rows={5} />
        <CardSkeleton rows={5} />
      </div>
    </div>
  );
}
