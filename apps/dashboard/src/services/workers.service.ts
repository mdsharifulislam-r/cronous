import { api } from '@/lib/api/client';
import type { Worker, WorkerDetail } from '@/types/api';

export const workersService = {
  list: () => api.get<Worker[]>('/workers'),
  get: (workerId: string) => api.get<WorkerDetail>(`/workers/${workerId}`),
};
