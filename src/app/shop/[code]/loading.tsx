import { CardSkeleton, HeadingSkeleton, Line } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Карточка лавки загружается">
      <HeadingSkeleton />
      <div className="surface p-3">
        <Line w="16rem" h="2.4rem" />
      </div>
      {/* День лавки — крупная карточка; их за период обычно несколько. */}
      <CardSkeleton rows={5} />
      <CardSkeleton rows={5} />
    </div>
  );
}
