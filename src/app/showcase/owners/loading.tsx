import { CardSkeleton, HeadingSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Отчёт загружается">
      <HeadingSkeleton />
      <CardSkeleton rows={8} />
      <CardSkeleton rows={6} />
    </div>
  );
}
