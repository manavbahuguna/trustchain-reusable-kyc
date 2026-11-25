import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ResearchApp from './ResearchApp.jsx';
const legacy = new URLSearchParams(location.search).has('legacy');
if (legacy) {
  Promise.all([import('./App.jsx'), import('./styles/app.css')]).then(([{ default: App }]) => {
    createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
  });
} else createRoot(document.getElementById('root')).render(<StrictMode><ResearchApp /></StrictMode>);
