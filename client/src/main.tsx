import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './style.css';
import { initFontTheme } from './utils/fontTheme';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

initFontTheme();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
