import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui.css';

export function mountPage(app: ReactNode): void {
  createRoot(document.getElementById('root')!).render(app);
}
