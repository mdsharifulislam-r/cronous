'use client';
import { create } from 'zustand';

export interface AppNotification {
  id: string;
  tone: 'danger' | 'warning' | 'info' | 'success';
  title: string;
  description?: string;
  href?: string;
  at: number;
  read: boolean;
}

/** Notifications raised from real-time events during this browser session (not persisted server-side). */
interface NotificationState {
  items: AppNotification[];
  push: (notification: Omit<AppNotification, 'at' | 'read'>) => void;
  markAllRead: () => void;
  clear: () => void;
}

const MAX = 50;

export const useNotifications = create<NotificationState>()((set) => ({
  items: [],
  push: (notification) =>
    set((state) => {
      if (state.items.some((item) => item.id === notification.id)) return state; // duplicate event
      return { items: [{ ...notification, at: Date.now(), read: false }, ...state.items].slice(0, MAX) };
    }),
  markAllRead: () => set((state) => ({ items: state.items.map((item) => ({ ...item, read: true })) })),
  clear: () => set({ items: [] }),
}));
