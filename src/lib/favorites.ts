import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFavoriteIds, setFavorite } from './api';
import { useSession } from './session';

export function useFavorites() {
  const { status, profile } = useSession();
  const qc = useQueryClient();
  const enabled = status === 'authenticated' && !!profile;
  const q = useQuery({ queryKey: ['favorites', profile?.id], queryFn: getFavoriteIds, enabled });
  const m = useMutation({
    mutationFn: ({ productId, on }: { productId: string; on: boolean }) => setFavorite(profile!.id, productId, on),
    onMutate: async ({ productId, on }) => {
      await qc.cancelQueries({ queryKey: ['favorites', profile?.id] });
      const prev = qc.getQueryData<string[]>(['favorites', profile?.id]) ?? [];
      qc.setQueryData(['favorites', profile?.id], on ? [productId, ...prev.filter((x) => x !== productId)] : prev.filter((x) => x !== productId));
      return { prev };
    },
    onError: (_e, _v, ctx) => qc.setQueryData(['favorites', profile?.id], ctx?.prev),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['favorites', profile?.id] }),
  });
  const ids = q.data ?? [];
  return {
    enabled,
    ids,
    isLoading: q.isLoading,
    isError: q.isError,
    refetch: q.refetch,
    has: (id: string) => ids.includes(id),
    toggle: (id: string) => m.mutate({ productId: id, on: !ids.includes(id) }),
  };
}
