import { CardSkeleton, HeadingSkeleton, Line } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Витрины загружаются">
      <HeadingSkeleton />
      <div className="surface flex flex-wrap items-center gap-3 p-3">
        <Line w="12rem" h="2.4rem" />
        <Line w="10rem" h="1rem" />
      </div>
      <CardSkeleton rows={10} />
    </div>
  );
}
