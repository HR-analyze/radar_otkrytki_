import { CardSkeleton, HeadingSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="История загружается">
      <HeadingSkeleton />
      <CardSkeleton rows={6} />
      <div className="grid gap-5 lg:grid-cols-2">
        <CardSkeleton rows={5} />
        <CardSkeleton rows={5} />
      </div>
    </div>
  );
}
