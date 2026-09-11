import { CardSkeleton, HeadingSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Пороги загружаются">
      <HeadingSkeleton />
      <CardSkeleton rows={6} />
      <CardSkeleton rows={8} />
    </div>
  );
}
