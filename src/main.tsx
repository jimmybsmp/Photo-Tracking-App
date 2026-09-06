import { createRoot } from 'react-dom/client';
import App from './App';
import '@/styles/fonts.css';
import '@/styles/index.css';
import '@/styles/print.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
