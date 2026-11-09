import { create } from 'zustand';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error' | 'success';
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, tone?: Toast['tone'], action?: ToastAction) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  show: (message, tone = 'info', action) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, tone, action }] }));
    // Toasts with an action stay long enough to reach it.
    setTimeout(() => get().dismiss(id), action ? 6000 : 3000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (message: string, tone?: Toast['tone'], action?: ToastAction) => useToastStore.getState().show(message, tone, action);
